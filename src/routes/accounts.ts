import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import type { AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { accountList, balance, financialWrite, FinanceError, requireFunds } from '../lib/finance'
import { fromCents, toCents, toCentsNonNegative } from '../lib/money'
import { parseDay } from '../lib/dates'
import { invalidateRecurring } from '../lib/recurring'

export const accountsRouter = Router()

accountsRouter.get('/dashboard/summary', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!,
      accountId = req.query.accountId
    if (accountId !== undefined && !validId(accountId))
      throw new FinanceError('Invalid account ID.')
    const result = await prisma.$transaction(async db => {
      const account = accountId
        ? await db.account.findFirst({
            where: { id: String(accountId), userId, archived: false, isGoal: false }
          })
        : null
      if (accountId && !account) throw new FinanceError('Choose an active account.', 404)
      const where = {
        userId,
        ...(account
          ? account.isMain
            ? { OR: [{ accountId: account.id }, { accountId: null }] }
            : { accountId: account.id }
          : {})
      }
      const [income, expense, count] = await Promise.all([
        db.transaction.aggregate({ where: { ...where, type: 'INCOME' }, _sum: { amount: true } }),
        db.transaction.aggregate({ where: { ...where, type: 'EXPENSE' }, _sum: { amount: true } }),
        db.transaction.count({ where })
      ])
      const totalIncome = income._sum.amount || 0,
        totalExpense = expense._sum.amount || 0
      const funds = account
        ? await balance(userId, account.id, db)
        : totalIncome -
          totalExpense +
          ((await db.account.aggregate({ where: { userId }, _sum: { openingBalance: true } }))._sum
            .openingBalance || 0)
      return {
        globalBalance: fromCents(funds),
        totalIncome: fromCents(totalIncome),
        totalExpense: fromCents(totalExpense),
        transactionCount: count
      }
    })
    res.json(result)
  } catch (e) {
    failure(res, e)
  }
})
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
const nameOf = (name: unknown) =>
  typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 60
    ? name.trim()
    : null
const failure = (res: import('express').Response, error: unknown) => {
  if (!(error instanceof FinanceError)) console.error('Financial operation failed.', error)
  return res.status(error instanceof FinanceError ? error.status : 500).json({
    error: error instanceof FinanceError ? error.message : 'Could not save the financial operation.'
  })
}

accountsRouter.get('/accounts', async (req: AuthRequest, res) => {
  try {
    res.json((await accountList(req.userId!)).filter(a => !a.isGoal))
  } catch (e) {
    failure(res, e)
  }
})
accountsRouter.post('/accounts', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!,
      body = req.body ?? {},
      id = body.id ?? body.clientId ?? randomUUID()
    if (!validId(id)) throw new FinanceError('Invalid account ID.')
    const result = await financialWrite(userId, `account:create:${id}`, async db => {
      const name = nameOf(body.name),
        openingBalance = toCentsNonNegative(body.openingBalance ?? 0)
      if (!name || openingBalance === null)
        throw new FinanceError('Enter a name and a nonnegative opening balance.')
      const row = await db.account.create({ data: { id, name, openingBalance, userId } })
      return {
        ...row,
        openingBalance: fromCents(openingBalance),
        balance: fromCents(openingBalance)
      }
    })
    invalidateRecurring(userId)
    res.status(201).json(result)
  } catch (e) {
    failure(res, e)
  }
})
accountsRouter.put('/accounts/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!,
      id = String(req.params.id),
      body = req.body ?? {}
    const result = await financialWrite(
      userId,
      validId(body.mutationId) ? `account:edit:${body.mutationId}` : null,
      async db => {
        const row = await db.account.findFirst({ where: { id, userId } })
        if (!row || row.isGoal) throw new FinanceError('Account not found.', 404)
        const name = nameOf(body.name ?? row.name),
          openingBalance = toCentsNonNegative(body.openingBalance ?? fromCents(row.openingBalance))
        if (!name || openingBalance === null || (row.isMain && (name !== 'Main' || body.archived)))
          throw new FinanceError('Main must remain available. Enter valid account details.')
        if (
          body.archived &&
          ((await balance(userId, id, db)) !== 0 ||
            (await db.recurringRule.count({ where: { userId, accountId: id, active: true } })))
        )
          throw new FinanceError(
            'Empty the account and pause its recurring rules before archiving.',
            409
          )
        await db.account.update({
          where: { id },
          data: {
            name,
            openingBalance,
            archived: typeof body.archived === 'boolean' ? body.archived : row.archived
          }
        })
        await requireFunds(userId, [id], db)
        return { success: true }
      }
    )
    invalidateRecurring(userId)
    res.json(result)
  } catch (e) {
    failure(res, e)
  }
})
accountsRouter.get('/transfers', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!,
      accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined
    const where = {
      userId,
      ...(accountId ? { OR: [{ sourceId: accountId }, { destinationId: accountId }] } : {})
    }
    const perPage = 15,
      total = await prisma.transfer.count({ where }),
      totalPages = Math.max(1, Math.ceil(total / perPage))
    const page = Math.min(totalPages, Math.max(1, Math.floor(Number(req.query.page) || 1)))
    const rows = await prisma.transfer.findMany({
      where,
      include: { source: true, destination: true },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * perPage,
      take: perPage
    })
    res.json({
      items: rows.map(row => ({ ...row, amount: fromCents(row.amount) })),
      total,
      page,
      totalPages,
      perPage
    })
  } catch (e) {
    failure(res, e)
  }
})
for (const method of ['post', 'put', 'delete'] as const)
  accountsRouter[method](
    method === 'post' ? '/transfers' : '/transfers/:id',
    async (req: AuthRequest, res) => {
      try {
        const userId = req.userId!,
          body = req.body ?? {},
          id = method === 'post' ? (body.id ?? body.clientId) : String(req.params.id)
        if (!validId(id)) throw new FinanceError('Invalid transfer ID.')
        if (method === 'put' && !validId(body.mutationId))
          throw new FinanceError('A stable mutation ID is required.')
        const key = `transfer:${method}:${method === 'put' ? body.mutationId : id}`
        const result = await financialWrite(userId, key, async db => {
          const old = await db.transfer.findFirst({ where: { id, userId } })
          if (method !== 'post' && !old) throw new FinanceError('Transfer not found.', 404)
          if (method === 'delete') {
            await db.transfer.delete({ where: { id } })
            await requireFunds(userId, [old!.sourceId, old!.destinationId], db)
            return { success: true }
          }
          const sourceId = String(body.sourceId ?? ''),
            destinationId = String(body.destinationId ?? ''),
            amount = toCents(body.amount),
            date = parseDay(body.date)
          if (
            sourceId === destinationId ||
            amount === null ||
            !date ||
            date > res.locals.today ||
            typeof body.comment !== 'string' ||
            body.comment.length > 200
          )
            throw new FinanceError(
              'Choose different accounts, a positive amount, a valid date and a comment of at most 200 characters.'
            )
          const accounts = await db.account.findMany({
            where: { userId, archived: false, id: { in: [sourceId, destinationId] } }
          })
          if (accounts.length === 2 && accounts.every(a => a.isGoal))
            throw new FinanceError('Transfer savings through a normal account.')
          if (accounts.length !== 2) throw new FinanceError('Choose two active accounts.')
          const data = {
            userId,
            sourceId,
            destinationId,
            amount,
            date,
            comment: body.comment.trim()
          }
          const row =
            method === 'post'
              ? await db.transfer.create({ data: { id, ...data } })
              : await db.transfer.update({ where: { id }, data })
          await requireFunds(
            userId,
            [sourceId, destinationId, ...(old ? [old.sourceId, old.destinationId] : [])],
            db
          )
          return { ...row, amount: fromCents(row.amount) }
        })
        invalidateRecurring(userId)
        res.status(method === 'post' ? 201 : 200).json(result)
      } catch (e) {
        failure(res, e)
      }
    }
  )

accountsRouter.get('/goals', async (req: AuthRequest, res) => {
  try {
    res.json((await accountList(req.userId!)).filter(a => a.isGoal && !a.archived))
  } catch (e) {
    failure(res, e)
  }
})
for (const method of ['post', 'put', 'delete'] as const)
  accountsRouter[method](
    method === 'post' ? '/goals' : '/goals/:id',
    async (req: AuthRequest, res) => {
      try {
        const userId = req.userId!,
          body = req.body ?? {},
          id = method === 'post' ? body.id : String(req.params.id)
        if (!validId(id) || (method === 'put' && !validId(body.mutationId)))
          throw new FinanceError('A stable operation ID is required.')
        const result = await financialWrite(
          userId,
          `goal:${method}:${method === 'put' ? body.mutationId : id}`,
          async db => {
            const old = await db.account.findFirst({ where: { id, userId, isGoal: true } })
            if (method !== 'post' && !old) throw new FinanceError('Goal not found.', 404)
            if (method === 'delete') {
              if ((await balance(userId, id, db)) !== 0)
                throw new FinanceError(
                  'Withdraw the remaining funds before removing the goal.',
                  409
                )
              await db.account.update({ where: { id }, data: { archived: true } })
              return { success: true }
            }
            if (old?.archived) throw new FinanceError('The goal is archived.', 409)
            const name = nameOf(body.name),
              targetAmount = toCents(body.targetAmount)
            if (!name || targetAmount === null)
              throw new FinanceError(
                'Enter a goal name and positive target with up to two decimals.'
              )
            const row =
              method === 'post'
                ? await db.account.create({
                    data: { id, userId, name, targetAmount, isGoal: true }
                  })
                : await db.account.update({ where: { id }, data: { name, targetAmount } })
            return {
              ...row,
              targetAmount: fromCents(targetAmount),
              openingBalance: 0,
              balance: fromCents(await balance(userId, id, db))
            }
          }
        )
        res.status(method === 'post' ? 201 : 200).json(result)
      } catch (e) {
        failure(res, e)
      }
    }
  )
