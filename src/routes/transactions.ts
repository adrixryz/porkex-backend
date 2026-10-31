import type { Prisma } from '@prisma/client'
import { AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { isUniqueViolation } from '../lib/errors'
import { transactionFilters } from '../lib/transactionFilters'
import { tagInclude } from '../lib/tags'
import { invalidateRecurring } from '../lib/recurring'
import { dayKey, parseInstant } from '../lib/dates'
import { fromCents } from '../lib/money'
import { requireFunds, captureFunds, financialWrite, FinanceError } from '../lib/finance'
import { Router } from 'express'
import {
  SORT_FIELDS,
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  serializeTransaction,
  parseIntParam,
  parseClientId,
  validateTransactionInput
} from './apiShared'

export const transactionsRouter = Router()

transactionsRouter.get('/transactions', async (req: AuthRequest, res) => {
  const userId = req.userId!
  try {
    const q = req.query as Record<string, unknown>
    const where = await transactionFilters(userId, q)
    const historyWhere = { ...where }
    delete historyWhere.date

    // Default order is by the movement date, newest first; id breaks ties.
    const sortBy = SORT_FIELDS.includes(q.sortBy as (typeof SORT_FIELDS)[number])
      ? (q.sortBy as 'date' | 'amount')
      : 'date'
    const order: Prisma.SortOrder = q.order === 'asc' ? 'asc' : 'desc'

    const requestedPage = Math.max(1, parseIntParam(q.page, 1))
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, parseIntParam(q.perPage, DEFAULT_PER_PAGE)))

    const orderBy: Prisma.TransactionOrderByWithRelationInput[] = [
      { [sortBy]: order },
      { id: order }
    ]

    // The count and the page used to be two sequential round trips. They are
    // independent unless the requested page is past the end, because only then
    // does the clamped offset change the read.
    const [summary, firstPage, history] = await Promise.all([
      prisma.transaction.aggregate({ where, _count: { _all: true }, _sum: { amount: true } }),
      prisma.transaction.findMany({
        where,
        include: { category: true, account: true, ...tagInclude },
        orderBy,
        skip: (requestedPage - 1) * perPage,
        take: perPage
      }),
      prisma.transaction.aggregate({ where: historyWhere, _min: { date: true } })
    ])

    // Clamp instead of returning an empty page beyond the last one.
    const total = summary._count._all
    const totalPages = Math.max(1, Math.ceil(total / perPage))
    const page = Math.min(requestedPage, totalPages)

    // Rare: the page asked for does not exist, so re-read at the clamped offset.
    const items =
      page === requestedPage
        ? firstPage
        : await prisma.transaction.findMany({
            where,
            include: { category: true, account: true, ...tagInclude },
            orderBy,
            skip: (page - 1) * perPage,
            take: perPage
          })

    res.json({
      items: items.map(serializeTransaction),
      total,
      totalAmount: fromCents(summary._sum.amount),
      page,
      perPage,
      totalPages,
      earliestDate: history._min.date ? dayKey(history._min.date) : null
    })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to fetch transactions', error)
    res.status(500).json({ error: 'Failed to fetch transactions' })
  }
})

transactionsRouter.post('/transactions', async (req: AuthRequest, res) => {
  const userId = req.userId!

  const findByClientId = (clientId: string | null) =>
    prisma.transaction.findFirst({
      where: { clientId, userId },
      include: { category: true, account: true, ...tagInclude }
    })

  let clientId: string | null = null
  try {
    const parsed = parseClientId(req.body?.clientId)
    if (!parsed.ok) return res.status(400).json({ error: 'Invalid clientId.' })
    clientId = parsed.value

    // Idempotent replay: the frontend queues writes that fail and sends them
    // again later, and a create whose response was lost in transit must not
    // land twice. Answer 200 (not 201) because nothing was created.
    if (clientId) {
      const existing = await findByClientId(clientId)
      if (existing) return res.status(200).json(serializeTransaction(existing))
    }

    const result = await financialWrite(
      userId,
      clientId ? `movement:create:${clientId}` : null,
      async db => {
        const v = await validateTransactionInput(userId, req.body ?? {}, db, res.locals.today)
        if (v.error) throw new FinanceError(v.error)

        const previousFunds = await captureFunds(userId, [v.accountId], db)
        const tx = await db.transaction.create({
          data: {
            accountId: v.accountId!,
            amount: v.amount!,
            type: v.type!,
            description: v.description!,
            categoryId: v.categoryId!,
            userId,
            tags: { create: (v.tagIds ?? []).map(tagId => ({ tagId })) },
            // A missing date defaults to today's calendar day (UTC midnight), not
            // to the current instant: `date` is a day, `createdAt` is the clock.
            date: v.date ?? res.locals.today,
            editedAt: new Date(),
            ...(clientId ? { clientId } : {})
          },
          include: { category: true, account: true, ...tagInclude }
        })
        await requireFunds(userId, [v.accountId], db, previousFunds)
        return serializeTransaction(tx)
      }
    )
    invalidateRecurring(userId)
    res.status(201).json(result)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    // Two replays can both pass the lookup above and race to insert. The unique
    // constraint catches the loser, which is the same situation as a replay
    // that had already succeeded, so answer with the stored row.
    if (clientId && isUniqueViolation(error)) {
      const existing = await findByClientId(clientId)
      if (existing) return res.status(200).json(serializeTransaction(existing))
    }
    console.error('Transaction creation failed.', error)
    res.status(500).json({ error: 'Transaction creation failed.' })
  }
})

transactionsRouter.put('/transactions/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const txId = Number(req.params.id)
  if (!Number.isInteger(txId) || txId <= 0) {
    return res.status(400).json({ error: 'Invalid transaction id.' })
  }
  try {
    const editedAt = parseInstant(req.body?.editedAt)
    const mutationId = req.body?.mutationId
    if (typeof mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(mutationId) || !editedAt) {
      return res.status(428).json({
        code: 'CLIENT_UPDATE_REQUIRED',
        error: 'Update Porkex before editing this movement.'
      })
    }
    if (editedAt.getTime() > Date.now() + 5 * 60_000) {
      return res.status(400).json({
        code: 'DEVICE_CLOCK_AHEAD',
        error: 'The device clock is ahead. Enable automatic date and time before retrying.'
      })
    }
    const result = await financialWrite(
      userId,
      `movement:edit:${mutationId}`,
      async db => {
        const existing = await db.transaction.findFirst({
          where: { id: txId, userId },
          include: { category: true, account: true, ...tagInclude }
        })
        if (!existing) return { status: 404, error: 'Transaction not found.' }
        const previousTime = (existing.editedAt ?? existing.createdAt).getTime()
        if (existing.lastEditId === mutationId) return { tx: existing, syncStatus: 'applied' }
        if (
          editedAt.getTime() < previousTime ||
          (editedAt.getTime() === previousTime && mutationId <= (existing.lastEditId ?? ''))
        ) {
          return { tx: existing, syncStatus: 'superseded' }
        }
        const v = await validateTransactionInput(
          userId,
          { ...req.body, accountId: req.body.accountId ?? existing.accountId },
          db,
          res.locals.today
        )
        if (v.error) return { status: 400, error: v.error }
        const previousFunds = await captureFunds(userId, [existing.accountId, v.accountId], db)
        const tx = await db.transaction.update({
          where: { id: txId },
          data: {
            accountId: v.accountId!,
            amount: v.amount!,
            type: v.type!,
            description: v.description!,
            categoryId: v.categoryId!,
            editedAt,
            lastEditId: mutationId,
            ...(v.date ? { date: v.date } : {}),
            ...(v.tagIds !== undefined
              ? { tags: { deleteMany: {}, create: v.tagIds.map(tagId => ({ tagId })) } }
              : {})
          },
          include: { category: true, account: true, ...tagInclude }
        })
        await requireFunds(userId, [existing.accountId, v.accountId], db, previousFunds)
        return { tx, syncStatus: 'applied' }
      },
      async (db, original) => {
        const current = await db.transaction.findFirst({
          where: { id: txId, userId },
          include: { category: true, account: true, ...tagInclude }
        })
        return current
          ? {
              tx: current,
              syncStatus: current.lastEditId === mutationId ? 'applied' : 'superseded'
            }
          : original
      }
    )
    if ('error' in result) return res.status(result.status!).json({ error: result.error })
    invalidateRecurring(userId)
    res.json({ ...serializeTransaction(result.tx!), syncStatus: result.syncStatus })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Transaction update failed.', error)
    res.status(500).json({ error: 'Transaction update failed.' })
  }
})

transactionsRouter.delete('/transactions/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const txId = Number(req.params.id)
  if (!Number.isInteger(txId) || txId <= 0) {
    return res.status(400).json({ error: 'Invalid transaction id.' })
  }
  try {
    await financialWrite(userId, `movement:delete:${txId}`, async db => {
      const existing = await db.transaction.findFirst({ where: { id: txId, userId } })
      if (!existing) throw new FinanceError('Transaction not found.', 404)
      const previousFunds = await captureFunds(userId, [existing.accountId], db)
      await db.transaction.delete({ where: { id: txId } })
      await requireFunds(userId, [existing.accountId], db, previousFunds)
      return { success: true }
    })
    invalidateRecurring(userId)
    res.json({ success: true })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Delete failed.', error)
    res.status(500).json({ error: 'Delete failed.' })
  }
})
