import { AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { fromCents } from '../lib/money'
import { tagInclude } from '../lib/tags'
import { dayKey } from '../lib/dates'
import { FinanceError, accountTransactionScope } from '../lib/finance'
import { Router } from 'express'
import { serializeTransaction, resolveRange } from './apiShared'

export const dashboardRouter = Router()

dashboardRouter.get('/dashboard', async (req: AuthRequest, res) => {
  const userId = req.userId!
  try {
    const { account, where } = await accountTransactionScope(userId, req.query.accountId)
    const { range, error } = resolveRange(req.query as Record<string, unknown>)
    if (error) return res.status(400).json({ error })
    const periodWhere = { ...where, ...(range ? { date: range } : {}) }
    const [
      transactions,
      movementsByCategory,
      history,
      categories,
      movements,
      opening,
      incoming,
      outgoing
    ] = await Promise.all([
      prisma.transaction.findMany({
        where: periodWhere,
        include: { category: true, account: true, ...tagInclude },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 8
      }),
      prisma.transaction.groupBy({
        by: ['categoryId', 'type'],
        _sum: { amount: true },
        _count: { _all: true },
        where: periodWhere
      }),
      prisma.transaction.aggregate({ where, _min: { date: true } }),
      prisma.category.findMany({ where: { userId } }),
      prisma.transaction.groupBy({ by: ['type'], where, _sum: { amount: true } }),
      account
        ? Promise.resolve({ _sum: { openingBalance: account.openingBalance } })
        : prisma.account.aggregate({ where: { userId }, _sum: { openingBalance: true } }),
      account
        ? prisma.transfer.aggregate({
            where: { userId, destinationId: account.id },
            _sum: { amount: true }
          })
        : Promise.resolve({ _sum: { amount: 0 } }),
      account
        ? prisma.transfer.aggregate({
            where: { userId, sourceId: account.id },
            _sum: { amount: true }
          })
        : Promise.resolve({ _sum: { amount: 0 } })
    ])
    const catById = new Map(categories.map(category => [category.id, category]))
    const pieChartData: { label: string; value: number; color: string }[] = []
    const incomePieChartData: typeof pieChartData = []
    for (const g of movementsByCategory) {
      const cat = catById.get(g.categoryId)
      if (cat && g._sum.amount) {
        const target = g.type === 'Income' ? incomePieChartData : pieChartData
        target.push({
          label: cat.name,
          value: fromCents(g._sum.amount),
          color: cat.color || '#ccc'
        })
      }
    }

    const totalIncome = movementsByCategory
      .filter(group => group.type === 'Income')
      .reduce((sum, group) => sum + (group._sum.amount || 0), 0)
    const totalExpense = movementsByCategory
      .filter(group => group.type === 'Expense')
      .reduce((sum, group) => sum + (group._sum.amount || 0), 0)
    const transactionCount = movementsByCategory.reduce((sum, group) => sum + group._count._all, 0)
    const currentBalance =
      (opening._sum.openingBalance || 0) +
      movements.reduce(
        (sum, group) => sum + (group.type === 'Income' ? 1 : -1) * (group._sum.amount || 0),
        0
      ) +
      (incoming._sum.amount || 0) -
      (outgoing._sum.amount || 0)

    res.json({
      globalBalance: fromCents(currentBalance),
      totalIncome: fromCents(totalIncome),
      totalExpense: fromCents(totalExpense),
      transactionCount,
      earliestDate: history._min.date ? dayKey(history._min.date) : null,
      recentTransactions: transactions.map(serializeTransaction),
      pieChartData,
      incomePieChartData
    })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to load dashboard', error)
    res.status(500).json({ error: 'Failed to load dashboard' })
  }
})
