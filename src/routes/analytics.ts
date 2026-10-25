import { AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { fromCents } from '../lib/money'
import { dayKey, monthKey } from '../lib/dates'
import { FinanceError, accountTransactionScope } from '../lib/finance'
import { Router } from 'express'
import {
  MIN_ANALYTICS_MONTHS,
  MAX_ANALYTICS_MONTHS,
  MIN_ANALYTICS_DAYS,
  MAX_ANALYTICS_DAYS,
  resolveToday,
  rangeParam
} from './apiShared'

export const analyticsRouter = Router()

analyticsRouter.get('/analytics', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const months = rangeParam(req.query.months, MIN_ANALYTICS_MONTHS, MAX_ANALYTICS_MONTHS, 6)
  const days = rangeParam(req.query.days, MIN_ANALYTICS_DAYS, MAX_ANALYTICS_DAYS, 30)

  // Anchor every window on the client's own calendar day, so the buckets do
  // not flip hours before midnight for a user west of UTC (or after it, east).
  const today = resolveToday(req.query as Record<string, unknown>, res.locals.today)
  if (!today) return res.status(400).json({ error: 'Invalid "today" date.' })

  try {
    const { account, where: scope } = await accountTransactionScope(
      userId,
      req.query.accountId,
      true
    )
    const adjustmentScope = { userId, ...(account ? { accountId: account.id } : {}) }
    const transferScope = {
      userId,
      ...(account ? { OR: [{ sourceId: account.id }, { destinationId: account.id }] } : {})
    }
    // Window bounds: months drive the buckets, days drive the balance trend.
    // All arithmetic is UTC; the stored dates are UTC midnights.
    const monthsWindowStart = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (months - 1), 1)
    )
    const trendWindowStart = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1))
    )
    const windowStart = monthsWindowStart < trendWindowStart ? monthsWindowStart : trendWindowStart

    const [
      categories,
      windowTx,
      olderIncome,
      olderExpense,
      accountOpening,
      allAdjustments,
      earlierAdjustments,
      windowAdjustments,
      olderTransfers,
      windowTransfers
    ] = await Promise.all([
      prisma.category.findMany({
        where: { userId },
        select: { id: true, name: true, color: true }
      }),
      // Only the rows inside the window are shipped; older ones stay in the DB.
      prisma.transaction.findMany({
        where: { ...scope, date: { gte: windowStart, lte: today } },
        select: { amount: true, type: true, date: true, categoryId: true },
        orderBy: { date: 'asc' }
      }),
      // The trend starts with everything before it as opening balance, summed by
      // the database. Two aggregates because income and expense carry signs.
      prisma.transaction.aggregate({
        where: { ...scope, type: 'Income', date: { lt: trendWindowStart } },
        _sum: { amount: true }
      }),
      prisma.transaction.aggregate({
        where: { ...scope, type: 'Expense', date: { lt: trendWindowStart } },
        _sum: { amount: true }
      }),
      prisma.account.aggregate({
        where: { userId, ...(account ? { id: account.id } : {}) },
        _sum: { openingBalance: true }
      }),
      prisma.balanceAdjustment.aggregate({
        where: adjustmentScope,
        _sum: { balance: true, previousBalance: true }
      }),
      prisma.balanceAdjustment.aggregate({
        where: { ...adjustmentScope, effectiveDate: { lt: trendWindowStart } },
        _sum: { balance: true, previousBalance: true }
      }),
      prisma.balanceAdjustment.findMany({
        where: { ...adjustmentScope, effectiveDate: { gte: trendWindowStart, lte: today } },
        select: { effectiveDate: true, balance: true, previousBalance: true }
      }),
      account
        ? prisma.transfer.findMany({
            where: { ...transferScope, date: { lt: trendWindowStart } },
            select: { sourceId: true, amount: true }
          })
        : Promise.resolve([]),
      account
        ? prisma.transfer.findMany({
            where: { ...transferScope, date: { gte: trendWindowStart, lte: today } },
            select: { sourceId: true, date: true, amount: true }
          })
        : Promise.resolve([])
    ])

    const catById = new Map(categories.map(c => [c.id, c]))
    const openingBalance =
      (accountOpening._sum.openingBalance || 0) -
      ((allAdjustments._sum.balance || 0) - (allAdjustments._sum.previousBalance || 0)) +
      ((earlierAdjustments._sum.balance || 0) - (earlierAdjustments._sum.previousBalance || 0)) +
      (olderIncome._sum.amount || 0) -
      (olderExpense._sum.amount || 0) +
      olderTransfers.reduce(
        (sum, transfer) => sum + (transfer.sourceId === account?.id ? -1 : 1) * transfer.amount,
        0
      )

    // Month buckets (income/expense) and day buckets (running balance).
    const monthBuckets: { key: string; label: string; income: number; expense: number }[] = []
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1))
      monthBuckets.push({
        key: monthKey(d),
        label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
        income: 0,
        expense: 0
      })
    }
    const monthIndex = new Map(monthBuckets.map((b, i) => [b.key, i]))
    const currentIdx = monthBuckets.length - 1
    const lastIdx = currentIdx - 1
    const currentKey = monthBuckets[currentIdx].key
    const lastKey = lastIdx >= 0 ? monthBuckets[lastIdx].key : ''

    // Spending per category for the current and previous month (tops and comparison).
    const currentByCat = new Map<number, number>()
    const lastByCat = new Map<number, number>()
    const netByDay = new Map<string, number>()
    for (const entry of windowAdjustments) {
      const key = dayKey(entry.effectiveDate)
      netByDay.set(key, (netByDay.get(key) || 0) + entry.balance - entry.previousBalance)
    }

    for (const transfer of windowTransfers) {
      const key = dayKey(transfer.date)
      netByDay.set(
        key,
        (netByDay.get(key) || 0) + (transfer.sourceId === account?.id ? -1 : 1) * transfer.amount
      )
    }

    // Single pass: O(n) instead of walking every transaction per bucket.
    for (const tx of windowTx) {
      const d = new Date(tx.date)
      const isIncome = tx.type === 'Income'
      const net = isIncome ? tx.amount : -tx.amount

      const mi = monthIndex.get(monthKey(d))
      if (mi !== undefined) {
        if (isIncome) {
          monthBuckets[mi].income += tx.amount
        } else {
          monthBuckets[mi].expense += tx.amount
          if (monthBuckets[mi].key === currentKey) {
            currentByCat.set(tx.categoryId, (currentByCat.get(tx.categoryId) || 0) + tx.amount)
          } else if (monthBuckets[mi].key === lastKey) {
            lastByCat.set(tx.categoryId, (lastByCat.get(tx.categoryId) || 0) + tx.amount)
          }
        }
      }

      if (d < trendWindowStart) {
        // Before the trend window but inside the months window: it counts
        // towards the monthly buckets only, never towards the balance.
      } else {
        const dk = dayKey(d)
        netByDay.set(dk, (netByDay.get(dk) || 0) + net)
      }
    }

    const monthlyData = monthBuckets.map((b, i) => {
      const window = monthBuckets.slice(Math.max(0, i - 2), i + 1)
      const avgExpense = window.length
        ? window.reduce((s, x) => s + x.expense, 0) / window.length
        : 0
      return {
        month: b.label,
        income: fromCents(b.income),
        expense: fromCents(b.expense),
        net: fromCents(b.income - b.expense),
        avgExpense: fromCents(avgExpense)
      }
    })

    const trendData: { date: string; balance: number }[] = []
    let balance = openingBalance
    for (let i = 0; i < days; i++) {
      const start = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1) + i)
      )
      balance += netByDay.get(dayKey(start)) || 0
      trendData.push({
        date: start.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC'
        }),
        balance: fromCents(balance)
      })
    }

    const current = monthBuckets[currentIdx]
    const last = lastIdx >= 0 ? monthBuckets[lastIdx] : null

    let expenseChangePercent: number | null = 0
    if (last) {
      if (last.expense > 0) {
        expenseChangePercent = Math.round(((current.expense - last.expense) / last.expense) * 100)
      } else if (current.expense > 0) {
        expenseChangePercent = null
      }
    }

    const catInfo = (id: number) => ({
      name: catById.get(id)?.name || 'Uncategorized',
      color: catById.get(id)?.color || '#5F6368'
    })

    const topCategories = [...currentByCat.entries()]
      .map(([catId, value]) => ({
        ...catInfo(catId),
        value: fromCents(value),
        percent: current.expense > 0 ? Math.round((value / current.expense) * 100) : 0
      }))
      .sort((a, b) => b.value - a.value)

    const comparisonIds = new Set([...currentByCat.keys(), ...lastByCat.keys()])
    const categoryComparison = [...comparisonIds]
      .map(catId => {
        const cur = currentByCat.get(catId) || 0
        const prev = lastByCat.get(catId) || 0
        return {
          ...catInfo(catId),
          current: fromCents(cur),
          previous: fromCents(prev),
          changePercent: prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0
        }
      })
      .sort((a, b) => b.current - a.current)
      .slice(0, 8)

    const dayOfMonth = today.getUTCDate()

    res.json({
      range: { months, days },
      monthlyData,
      trendData,
      topCategories,
      categoryComparison,
      insights: {
        currentMonthIncome: fromCents(current.income),
        currentMonthExpense: fromCents(current.expense),
        lastMonthExpense: fromCents(last?.expense || 0),
        expenseChangePercent,
        avgDailyExpense: dayOfMonth > 0 ? fromCents(current.expense / dayOfMonth) : 0,
        savingsRate:
          current.income > 0
            ? Math.round(((current.income - current.expense) / current.income) * 100)
            : 0,
        topCategories,
        categoryComparison
      }
    })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to load analytics', error)
    res.status(500).json({ error: 'Failed to load analytics' })
  }
})
