import { acceptFinancialEdit } from '../lib/financialEdits'
import { AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { fromCents, toCents } from '../lib/money'
import { isUniqueViolation } from '../lib/errors'
import { dashboardAccountScope } from '../lib/dashboardScope'
import {
  movementAccount,
  FinanceError,
  accountTransactionScope,
  mainAccount,
  accountOrder
} from '../lib/finance'
import { Router } from 'express'
import {
  parseCategoryId,
  resolveToday,
  parseClientId,
  BudgetPeriod,
  budgetRange,
  resolveWeekStart,
  parseBudgetPeriod
} from './apiShared'

export const budgetsRouter = Router()

budgetsRouter.get('/budgets', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const requested = req.query.period ? parseBudgetPeriod(req.query.period) : null
  if (req.query.period && !requested) {
    return res.status(400).json({ error: 'Period must be WEEK, MONTH or YEAR.' })
  }

  const today = resolveToday(req.query as Record<string, unknown>, res.locals.today)
  if (!today) return res.status(400).json({ error: 'Invalid "today" date.' })

  const weekStart = resolveWeekStart(req.query as Record<string, unknown>)
  if (weekStart === null) {
    return res.status(400).json({ error: 'Week start must be a day name (e.g. MONDAY).' })
  }

  try {
    // No period filter means all cycles, so each budget is measured on its own cycle.
    const { account, where: selectedAccountWhere } = await accountTransactionScope(
      userId,
      req.query.accountId
    )
    const main = await mainAccount(userId)
    const dashboardScope =
      !account && req.query.scope === 'dashboard' ? await dashboardAccountScope(userId) : null
    const accountWhere = dashboardScope ? { userId, OR: dashboardScope } : selectedAccountWhere
    const budgets = await prisma.budget.findMany({
      where: {
        userId,
        ...(requested ? { period: requested } : {}),
        ...(account
          ? account.isMain
            ? { OR: [{ accountId: account.id }, { accountId: null }] }
            : { accountId: account.id }
          : dashboardScope
            ? { OR: dashboardScope }
            : {})
      },
      include: {
        account: { select: { id: true, name: true, archived: true } },
        category: { select: { id: true, name: true, color: true, type: true, position: true } }
      },
      orderBy: [{ category: { position: 'asc' } }, { category: { name: 'asc' } }, { id: 'asc' }]
    })

    // Different budget cycles for the same category need different sums, so
    // spending is grouped once per period present in the list.
    const periods = [...new Set(budgets.map(b => b.period as BudgetPeriod))]
    const spentByPeriod = new Map<BudgetPeriod, Map<string, number>>()

    for (const period of periods) {
      const window = budgetRange(period, today, weekStart)
      const grouped = await prisma.transaction.groupBy({
        by: ['categoryId', 'accountId'],
        where: { ...accountWhere, type: 'Expense', date: { gte: window.from, lte: window.to } },
        _sum: { amount: true }
      })
      const sums = new Map<string, number>()
      for (const g of grouped) {
        const key = `${g.accountId ?? main.id}:${g.categoryId}`
        sums.set(key, (sums.get(key) || 0) + (g._sum.amount || 0))
      }
      spentByPeriod.set(period, sums)
    }

    const spentFor = (period: BudgetPeriod, categoryId: number, accountId: string | null): number =>
      spentByPeriod.get(period)?.get(`${accountId ?? main.id}:${categoryId}`) ?? 0

    const payload = budgets.map(b => {
      const period = b.period as BudgetPeriod
      const spent = spentFor(period, b.categoryId, b.accountId)
      return {
        id: b.id,
        accountId: b.accountId ?? main.id,
        account: b.account ?? { id: main.id, name: main.name, archived: main.archived },
        categoryId: b.categoryId,
        amount: fromCents(b.amount),
        period: b.period,
        spent: fromCents(spent),
        remaining: fromCents(b.amount - spent),
        usagePercent: b.amount > 0 ? Math.round((spent / b.amount) * 100) : 0,
        overBudget: spent > b.amount,
        category: b.category
      }
    })

    // Totals are grouped by period on purpose: a WEEK and a MONTH budget on the
    // same category cover the same movements, so summing them all would count twice.
    // Summed over the raw rows so the arithmetic stays in exact cents.
    const totals = periods.map(period => {
      const rows = budgets.filter(b => b.period === period)
      const amount = rows.reduce((s, b) => s + b.amount, 0)
      const spent = rows.reduce((s, b) => s + spentFor(period, b.categoryId, b.accountId), 0)
      return {
        period,
        amount: fromCents(amount),
        spent: fromCents(spent),
        // Any single budget over its limit flags the period, not just the aggregate.
        overBudget: rows.some(b => spentFor(period, b.categoryId, b.accountId) > b.amount),
        count: rows.length
      }
    })

    const accountPositions = new Map((await accountOrder(userId)).map((id, index) => [id, index]))
    payload.sort(
      (a, b) =>
        a.category.position - b.category.position ||
        a.category.name.localeCompare(b.category.name) ||
        (accountPositions.get(a.accountId) ?? Number.MAX_SAFE_INTEGER) -
          (accountPositions.get(b.accountId) ?? Number.MAX_SAFE_INTEGER) ||
        a.id - b.id
    )
    res.json({ budgets: payload, totals })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to fetch budgets', error)
    res.status(500).json({ error: 'Failed to fetch budgets' })
  }
})

budgetsRouter.post('/budgets', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const parsed = parseClientId(req.body?.clientId)
  if (!parsed.ok) return res.status(400).json({ error: 'Invalid clientId.' })
  const clientId = parsed.value
  const findExisting = () =>
    prisma.budget.findFirst({
      where: { userId, clientId },
      include: {
        account: { select: { id: true, name: true, archived: true } },
        category: { select: { id: true, name: true, color: true, type: true, position: true } }
      }
    })
  const replyExisting = async () => {
    if (!clientId) return false
    const existing = await findExisting()
    if (!existing) return false
    res.status(200).json({ ...existing, amount: fromCents(existing.amount) })
    return true
  }
  try {
    if (await replyExisting()) return
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Budget replay failed.', error)
    return res.status(500).json({ error: 'Budget creation failed.' })
  }
  const amount = toCents(req.body?.amount)
  if (amount === null) {
    return res
      .status(400)
      .json({ error: 'Amount must be a positive number within the allowed range.' })
  }

  const period = parseBudgetPeriod(req.body?.period)
  if (!period) {
    return res.status(400).json({ error: 'Period must be WEEK, MONTH or YEAR.' })
  }

  const categoryId = parseCategoryId(req.body?.categoryId)
  if (categoryId === null) {
    return res.status(400).json({ error: 'Valid categoryId is required.' })
  }

  try {
    const account = await movementAccount(userId, req.body?.accountId)
    const category = await prisma.category.findFirst({ where: { id: categoryId, userId } })
    if (!category) return res.status(404).json({ error: 'Category not found.' })
    if (category.type !== 'Expense')
      return res.status(400).json({ error: 'Choose an expense category for a spending budget.' })

    const existing = await prisma.budget.findFirst({
      where: {
        userId,
        categoryId,
        period,
        ...(account.isMain
          ? { OR: [{ accountId: account.id }, { accountId: null }] }
          : { accountId: account.id })
      }
    })
    if (existing) {
      return res
        .status(409)
        .json({ error: 'This account already has a budget for that category and period.' })
    }

    const budget = await prisma.budget.create({
      data: { userId, accountId: account.id, categoryId, amount, period, clientId },
      include: {
        account: { select: { id: true, name: true, archived: true } },
        category: { select: { id: true, name: true, color: true, type: true, position: true } }
      }
    })
    res.status(201).json({ ...budget, amount: fromCents(budget.amount) })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    // Two concurrent creates can both pass the "already exists" check.
    if (isUniqueViolation(error)) {
      if (await replyExisting()) return
      return res
        .status(409)
        .json({ error: 'This account already has a budget for that category and period.' })
    }
    console.error('Budget creation failed.', error)
    res.status(500).json({ error: 'Budget creation failed.' })
  }
})

budgetsRouter.put('/budgets/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const budgetId = Number(req.params.id)
  if (!Number.isInteger(budgetId) || budgetId <= 0) {
    return res.status(400).json({ error: 'Invalid budget id.' })
  }

  const amount = toCents(req.body?.amount)
  if (amount === null) {
    return res
      .status(400)
      .json({ error: 'Amount must be a positive number within the allowed range.' })
  }

  const period = parseBudgetPeriod(req.body?.period)
  if (!period) {
    return res.status(400).json({ error: 'Period must be WEEK, MONTH or YEAR.' })
  }

  try {
    const budget = await prisma.$transaction(async db => {
      await acceptFinancialEdit(db, userId, `budget:${budgetId}`, req.body ?? {})
      const existing = await db.budget.findFirst({ where: { id: budgetId, userId } })
      if (!existing) throw new FinanceError('Budget not found.', 404)
      const category = await db.category.findFirst({ where: { id: existing.categoryId, userId } })
      if (category?.type !== 'Expense')
        throw new FinanceError('Choose an expense category for a spending budget.')

      const account = await movementAccount(
        userId,
        req.body?.accountId ?? existing.accountId ?? undefined,
        db
      )
      const taken = await db.budget.findFirst({
        where: {
          userId,
          categoryId: existing.categoryId,
          period,
          id: { not: budgetId },
          ...(account.isMain
            ? { OR: [{ accountId: account.id }, { accountId: null }] }
            : { accountId: account.id })
        }
      })
      if (taken) {
        throw new FinanceError(
          'This account already has a budget for that category and period.',
          409
        )
      }

      const budget = await db.budget.update({
        where: { id: budgetId },
        data: { amount, period, accountId: account.id },
        include: {
          account: { select: { id: true, name: true, archived: true } },
          category: { select: { id: true, name: true, color: true, type: true, position: true } }
        }
      })
      return budget
    })
    res.json({ ...budget, amount: fromCents(budget.amount) })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    if (isUniqueViolation(error)) {
      return res
        .status(409)
        .json({ error: 'This account already has a budget for that category and period.' })
    }
    console.error('Budget update failed.', error)
    res.status(500).json({ error: 'Budget update failed.' })
  }
})

budgetsRouter.delete('/budgets/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const budgetId = Number(req.params.id)
  if (!Number.isInteger(budgetId) || budgetId <= 0) {
    return res.status(400).json({ error: 'Invalid budget id.' })
  }
  try {
    const existing = await prisma.budget.findFirst({ where: { id: budgetId, userId } })
    if (!existing) return res.status(404).json({ error: 'Budget not found.' })

    await prisma.budget.delete({ where: { id: budgetId } })
    res.json({ success: true })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Delete failed.', error)
    res.status(500).json({ error: 'Delete failed.' })
  }
})
