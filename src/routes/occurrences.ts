import { Router } from 'express'
import { prisma } from '../lib/prisma'
import type { AuthRequest } from '../middleware/auth'
import { parseDay, isDayString } from '../lib/dates'
import { nextOccurrence, parseFrequency } from '../lib/recurring'
import { commentInput, resolveTagIds } from '../lib/tags'
import { toCents } from '../lib/money'

export const occurrencesRouter = Router()
occurrencesRouter.put('/:ruleId/occurrences/:day', async (req: AuthRequest, res, next) => {
  const ruleId = Number(req.params.ruleId)
  const date = isDayString(req.params.day) ? parseDay(req.params.day)! : null
  const kind = req.body?.kind
  if (!Number.isInteger(ruleId) || !date || !['SKIP', 'EDIT'].includes(kind))
    return res
      .status(400)
      .json({ error: 'A rule, scheduled date and SKIP or EDIT action are required.' })
  try {
    const result = await prisma.$transaction(async db => {
      const rule = await db.recurringRule.findFirst({ where: { id: ruleId, userId: req.userId! } })
      if (!rule) return { status: 404, error: 'Recurring rule not found.' }
      const existing = await db.occurrenceOverride.findUnique({
        where: { ruleId_date: { ruleId, date } },
        include: { tags: true }
      })
      if (existing?.processedAt) {
        if (existing.kind === 'SKIP' && kind === 'SKIP')
          return { status: 200, alreadyApplied: true }
        if (
          existing.kind === 'EDIT' &&
          kind === 'EDIT' &&
          existing.amount === toCents(req.body.amount) &&
          existing.comment === commentInput(req.body) &&
          existing.categoryId === req.body.categoryId &&
          JSON.stringify(existing.tags.map(tag => tag.tagId).sort()) ===
            JSON.stringify((await resolveTagIds(req.userId!, req.body.tagIds ?? [], db))?.sort())
        )
          return { status: 200, alreadyApplied: true }
        return {
          status: 409,
          error: 'This occurrence has already been processed. Edit its movement instead.'
        }
      }
      if (!rule.active || rule.nextDate.getTime() !== date.getTime())
        return {
          status: 409,
          error: 'The next occurrence changed. Refresh the rule; no other date was modified.'
        }
      if (kind === 'SKIP') {
        const following = nextOccurrence(
          date,
          parseFrequency(rule.frequency)!,
          rule.interval,
          rule.startDate.getUTCDate()
        )
        await db.occurrenceOverride.upsert({
          where: { ruleId_date: { ruleId, date } },
          create: { ruleId, date, kind, processedAt: new Date() },
          update: {
            kind,
            processedAt: new Date(),
            amount: null,
            comment: null,
            categoryId: null,
            tags: { deleteMany: {} }
          }
        })
        await db.recurringRule.update({
          where: { id: ruleId },
          data: {
            nextDate: following,
            ...(date <= res.locals.today ? { lastProcessedDate: date } : {}),
            active: !(rule.endDate && following > rule.endDate)
          }
        })
      } else {
        const amount = toCents(req.body.amount)
        const comment = commentInput(req.body)
        const category = Number.isInteger(req.body.categoryId)
          ? await db.category.findFirst({
              where: { id: req.body.categoryId, userId: req.userId!, type: rule.type }
            })
          : null
        const tagIds = await resolveTagIds(req.userId!, req.body.tagIds ?? [], db)
        if (amount === null || comment === null || !category || tagIds === null)
          return {
            status: 400,
            error:
              'Provide a valid amount, category of the same type, optional comment and 0–5 tags.'
          }
        if (
          amount === rule.amount &&
          comment === rule.description &&
          category.id === rule.categoryId &&
          tagIds.length === 0
        ) {
          await db.occurrenceOverride.deleteMany({ where: { ruleId, date, processedAt: null } })
          return { status: 200, success: true }
        }
        const data = {
          kind,
          amount,
          comment,
          categoryId: category.id,
          tags: { create: tagIds.map(tagId => ({ tagId })) }
        }
        await db.occurrenceOverride.upsert({
          where: { ruleId_date: { ruleId, date } },
          create: { ruleId, date, ...data },
          update: { ...data, tags: { deleteMany: {}, create: tagIds.map(tagId => ({ tagId })) } }
        })
      }
      return { status: 200, success: true }
    })
    res.status(result.status).json(result)
  } catch (error) {
    next(error)
  }
})
