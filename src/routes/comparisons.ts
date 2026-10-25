import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { dayKey, addDays, isDayString, parseDay } from '../lib/dates'
import { comparisonRanges, compareMovements, compareCategories } from '../lib/comparison'
export const comparisonsRouter = Router()
const weekDays = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
comparisonsRouter.get('/category-comparison', async (req: AuthRequest, res, next) => {
  const mode = req.query.mode ?? 'month'
  const type = req.query.type ?? 'Expense'
  const today =
    req.query.today === undefined
      ? (res.locals.today as Date)
      : isDayString(req.query.today)
        ? parseDay(req.query.today)
        : null
  const weekStart = weekDays.indexOf(String(req.query.weekStart ?? 'MONDAY'))
  const anchor =
    req.query.anchor === undefined
      ? today
      : isDayString(req.query.anchor)
        ? parseDay(req.query.anchor)
        : null
  if (typeof type !== 'string' || !['Income', 'Expense'].includes(type))
    return res.status(400).json({ error: 'Choose Expense or Income.' })
  if (
    typeof mode !== 'string' ||
    !['day', 'month', 'week', 'year'].includes(mode) ||
    !today ||
    !anchor ||
    weekStart < 0
  )
    return res.status(400).json({ error: 'Provide a valid mode, anchor, today and weekStart.' })
  if (anchor > today)
    return res.status(400).json({ error: 'The comparison period cannot start in the future.' })
  const ranges =
    mode === 'day'
      ? {
          currentStart: anchor,
          currentEnd: addDays(anchor, 1),
          previousStart: addDays(anchor, -1),
          previousEnd: anchor,
          partial: false
        }
      : comparisonRanges(mode as 'month' | 'week' | 'year', anchor, today, weekStart)!
  try {
    const [rows, history] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          userId: req.userId!,
          type: String(type),
          OR: [
            { date: { gte: ranges.currentStart, lt: ranges.currentEnd } },
            { date: { gte: ranges.previousStart, lt: ranges.previousEnd } }
          ]
        },
        select: {
          amount: true,
          date: true,
          category: { select: { id: true, name: true, color: true } }
        }
      }),
      prisma.transaction.aggregate({ where: { userId: req.userId!, type }, _min: { date: true } })
    ])
    res.json({
      mode,
      type,
      anchor: dayKey(anchor),
      earliestDate: history._min.date ? dayKey(history._min.date) : null,
      partial: ranges.partial,
      ranges: {
        current: { from: dayKey(ranges.currentStart), to: dayKey(addDays(ranges.currentEnd, -1)) },
        previous: {
          from: dayKey(ranges.previousStart),
          to: dayKey(addDays(ranges.previousEnd, -1))
        }
      },
      categoryComparison: compareCategories(ranges, rows)
    })
  } catch (error) {
    next(error)
  }
})
comparisonsRouter.get('/comparison', async (req: AuthRequest, res, next) => {
  const mode = req.query.mode ?? 'year'
  const today =
    req.query.today === undefined
      ? (res.locals.today as Date)
      : isDayString(req.query.today)
        ? parseDay(req.query.today)
        : null
  const anchor =
    req.query.anchor === undefined
      ? today
      : isDayString(req.query.anchor)
        ? parseDay(req.query.anchor)
        : null
  const weekStart = weekDays.indexOf(String(req.query.weekStart ?? 'MONDAY'))
  if (!['year', 'week'].includes(String(mode)) || !today || !anchor || weekStart < 0)
    return res.status(400).json({ error: 'Provide a valid mode, anchor, today and weekStart.' })
  const ranges = comparisonRanges(mode as 'year' | 'week', anchor, today, weekStart)
  if (!ranges)
    return res.status(400).json({ error: 'The comparison period cannot start in the future.' })
  try {
    const rows = await prisma.transaction.findMany({
      where: {
        userId: req.userId!,
        OR: [
          { date: { gte: ranges.currentStart, lt: ranges.currentEnd } },
          { date: { gte: ranges.previousStart, lt: ranges.previousEnd } }
        ]
      },
      select: { amount: true, type: true, date: true }
    })
    res.json(compareMovements(mode as 'year' | 'week', ranges, rows))
  } catch (error) {
    next(error)
  }
})
