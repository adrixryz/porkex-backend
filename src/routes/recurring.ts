import { acceptFinancialEdit } from '../lib/financialEdits'
import { catchUp } from './catchUp'
import { AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { isUniqueViolation } from '../lib/errors'
import { nextOccurrence } from '../lib/recurring'
import { addDays, dayKey } from '../lib/dates'
import { movementAccount, FinanceError } from '../lib/finance'
import { resolveTagIds } from '../lib/tags'
import { Router } from 'express'
import { parseClientId, serializeRule, validateRecurringInput, initialNextDate } from './apiShared'

export const recurringRouter = Router()

const ruleInclude = {
  category: true,
  tags: { include: { tag: true } },
  exceptions: { where: { processedAt: null }, include: { tags: { include: { tag: true } } } }
} as const

recurringRouter.get('/recurring', async (req: AuthRequest, res) => {
  const userId = req.userId!
  try {
    const rules = await prisma.recurringRule.findMany({
      where: { userId },
      include: ruleInclude,
      // Active rules first; within each group, the ones that come due next.
      orderBy: [{ active: 'desc' }, { nextDate: 'asc' }, { id: 'asc' }]
    })
    res.json(rules.map(serializeRule))
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to fetch recurring rules.', error)
    res.status(500).json({ error: 'Failed to fetch recurring rules.' })
  }
})

recurringRouter.post('/recurring', async (req: AuthRequest, res) => {
  const userId = req.userId!

  const findByClientId = (clientId: string | null) =>
    prisma.recurringRule.findFirst({
      where: { clientId, userId },
      include: ruleInclude
    })

  let clientId: string | null = null
  try {
    const parsed = parseClientId(req.body?.clientId)
    if (!parsed.ok) return res.status(400).json({ error: 'Invalid clientId.' })
    clientId = parsed.value

    // Idempotent replay, exactly like POST /transactions: the frontend queues
    // writes that fail, and a create whose response was lost must not turn
    // into a second rule — which would double every future movement.
    if (clientId) {
      const existing = await findByClientId(clientId)
      if (existing) return res.status(200).json(serializeRule(existing))
    }

    const v = await validateRecurringInput(userId, req.body ?? {})
    if (v.error) return res.status(400).json({ error: v.error })

    const created = await prisma.$transaction(async db => {
      const account = await movementAccount(userId, req.body.accountId, db)
      const tags = await resolveTagIds(userId, req.body.tagIds ?? [], db)
      if (!tags) throw new FinanceError('Choose up to five available tags.')
      return db.recurringRule.create({
        data: {
          accountId: account.id,
          userId,
          amount: v.amount!,
          type: v.type!,
          description: v.description!,
          categoryId: v.categoryId!,
          frequency: v.frequency!,
          interval: v.interval!,
          startDate: v.startDate!,
          endDate: v.endDate ?? null,
          nextDate: initialNextDate(v.startDate!, v.frequency!, v.interval!, res.locals.today),
          ...(clientId ? { clientId } : {}),
          tags: { create: tags.map(tagId => ({ tagId })) }
        },
        include: ruleInclude
      })
    })

    // Materialize right away when the first occurrence falls on today, so the
    // response already reflects it instead of waiting for the next request.
    await catchUp(req, res, true)

    const fresh = await prisma.recurringRule.findUnique({
      where: { id: created.id },
      include: ruleInclude
    })
    res.status(201).json(serializeRule(fresh ?? created))
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    // Two replays racing: the loser answers with the stored row, like POST
    // /transactions does.
    if (clientId && isUniqueViolation(error)) {
      const existing = await findByClientId(clientId)
      if (existing) return res.status(200).json(serializeRule(existing))
    }
    console.error('Recurring rule creation failed.', error)
    res.status(500).json({ error: 'Recurring rule creation failed.' })
  }
})

recurringRouter.put('/recurring/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const ruleId = Number(req.params.id)
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    return res.status(400).json({ error: 'Invalid recurring rule id.' })
  }
  try {
    const updated = await prisma.$transaction(async db => {
      await acceptFinancialEdit(db, userId, `recurring:${ruleId}`, req.body ?? {})
      const existing = await db.recurringRule.findFirst({ where: { id: ruleId, userId } })
      if (!existing) throw new FinanceError('Recurring rule not found.', 404)

      const v = await validateRecurringInput(userId, req.body, db)
      if (v.error) throw new FinanceError(v.error)
      const tags =
        req.body.tagIds === undefined ? undefined : await resolveTagIds(userId, req.body.tagIds, db)
      if (tags === null) throw new FinanceError('Choose up to five available tags.')

      // Re-scheduling and resuming both restart the schedule at the first
      // occurrence that has not passed: the periods a pause (or an edit) skipped
      // are never materialized after the fact. The middleware already ran the
      // catch-up, so an occurrence that just materialized is not reconsidered.
      const endDate = req.body.endDate === undefined ? existing.endDate : (v.endDate ?? null)

      let active = typeof req.body.active === 'boolean' ? req.body.active : existing.active
      const scheduleChanged =
        existing.startDate.getTime() !== v.startDate!.getTime() ||
        existing.frequency !== v.frequency ||
        existing.interval !== v.interval
      const resumed = !existing.active && active
      let nextDate = existing.nextDate
      if (scheduleChanged || resumed) {
        const processedFloor = existing.lastProcessedDate
          ? addDays(existing.lastProcessedDate, 1)
          : res.locals.today
        const floor = processedFloor > res.locals.today ? processedFloor : res.locals.today
        nextDate = initialNextDate(v.startDate!, v.frequency!, v.interval!, floor)
      }
      // A future skip excludes its exact date, not every earlier calendar day.
      const skipped = await db.occurrenceOverride.findMany({
        where: { ruleId, kind: 'SKIP' },
        select: { date: true }
      })
      const skippedDays = new Set(skipped.map(item => dayKey(item.date)))
      while (skippedDays.has(dayKey(nextDate)))
        nextDate = nextOccurrence(nextDate, v.frequency!, v.interval!, v.startDate!.getUTCDate())
      if (endDate && nextDate > endDate) active = false

      await db.occurrenceOverride.deleteMany({
        where: {
          ruleId,
          processedAt: null,
          ...(existing.type !== v.type ? {} : { date: { not: nextDate } })
        }
      })
      const account = await movementAccount(userId, req.body.accountId ?? existing.accountId, db)
      const rule = await db.recurringRule.update({
        where: { id: ruleId },
        data: {
          accountId: account.id,
          amount: v.amount!,
          type: v.type!,
          description: v.description!,
          categoryId: v.categoryId!,
          frequency: v.frequency!,
          interval: v.interval!,
          startDate: v.startDate!,
          endDate,
          nextDate,
          active,
          ...(tags ? { tags: { deleteMany: {}, create: tags.map(tagId => ({ tagId })) } } : {})
        },
        include: ruleInclude
      })
      return rule
    })

    // A resume may make today's occurrence due again; settle it before
    // reading back so the response carries the advanced next date.
    await catchUp(req, res, true)

    const fresh = await prisma.recurringRule.findUnique({
      where: { id: ruleId },
      include: ruleInclude
    })
    res.json(serializeRule(fresh ?? updated))
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Recurring rule update failed.', error)
    res.status(500).json({ error: 'Recurring rule update failed.' })
  }
})

recurringRouter.delete('/recurring/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const ruleId = Number(req.params.id)
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    return res.status(400).json({ error: 'Invalid recurring rule id.' })
  }
  try {
    const existing = await prisma.recurringRule.findFirst({ where: { id: ruleId, userId } })
    if (!existing) return res.status(404).json({ error: 'Recurring rule not found.' })

    // The movements the rule already created are history: they stay, and only
    // lose the pointer to their template. Done here rather than left to the
    // foreign key's ON DELETE action, because the additive deploy tool cannot
    // add constraints to an existing production table.
    await prisma.$transaction([
      prisma.transaction.updateMany({
        where: { userId, recurringId: ruleId },
        data: { recurringId: null }
      }),
      prisma.recurringRule.delete({ where: { id: ruleId } })
    ])

    res.json({ success: true })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Recurring rule delete failed.', error)
    res.status(500).json({ error: 'Recurring rule delete failed.' })
  }
})
