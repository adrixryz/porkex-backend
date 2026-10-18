import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { dayKey, addDays, isDayString, parseDay } from '../lib/dates'
import { comparisonRanges, compareMovements, compareCategories } from '../lib/comparison'
export const comparisonsRouter = Router()
const weekDays = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
comparisonsRouter.get('/category-comparison', async (req: AuthRequest, res, next) => {
  const mode = req.query.mode ?? 'month'
  const today =
    req.query.today === undefined
      ? (res.locals.today as Date)
      : isDayString(req.query.today)
        ? parseDay(req.query.today)
        : null
  const weekStart = weekDays.indexOf(String(req.query.weekStart ?? 'MONDAY'))
  if (!['month', 'week', 'year'].includes(String(mode)) || !today || weekStart < 0)
    return res.status(400).json({ error: 'Provide a valid mode, today and weekStart.' })
  const ranges = comparisonRanges(mode as 'month' | 'week' | 'year', today, today, weekStart)!
  try {
    const rows = await prisma.transaction.findMany({
      where: {
        userId: req.userId!,
        type: 'EXPENSE',
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
    })
    res.json({
      mode,
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
