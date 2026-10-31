import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'
await withServer('dashboard-accounts', async ctx => {
  const { user, income, expense } = await createTestUser(ctx, 'unfunded@example.com')
  const main = `main-${user.id}`,
    cash = randomUUID()
  await ctx.call('POST', '/api/accounts', { id: cash, name: 'Cash', openingBalance: 25 })
  await ctx.call('POST', '/api/transactions', {
    accountId: main,
    type: 'Income',
    categoryId: income.id,
    amount: 100
  })
  await ctx.call('POST', '/api/transactions', {
    accountId: cash,
    type: 'Expense',
    categoryId: expense.id,
    amount: 5
  })
  const excluded = randomUUID()
  await ctx.call('POST', '/api/accounts', {
    id: excluded,
    name: 'Excluded account',
    openingBalance: 40,
    excludeFromTotalBalance: true
  })
  await ctx.call('POST', '/api/transactions', {
    accountId: excluded,
    type: 'Expense',
    categoryId: expense.id,
    amount: 7,
    comment: 'Excluded expense'
  })
  const summary = await ctx.call('GET', `/api/dashboard/summary?accountId=${cash}`)
  assert.deepEqual(summary.data, {
    globalBalance: 20,
    totalIncome: 0,
    totalExpense: 5,
    transactionCount: 1
  })
  const global = await ctx.call('GET', '/api/dashboard')
  assert.equal(global.data.globalBalance, 120)
  assert.equal(global.data.recentTransactions.length, 2)
  assert.equal(global.data.pieChartData[0].value, 5)
  assert.equal(global.data.totalIncome, 100)
  assert.equal(global.data.totalExpense, 5)
  assert.equal(global.data.transactionCount, 2)
  assert.ok(global.data.recentTransactions.every(row => row.comment !== 'Excluded expense'))
  const selectedExcluded = await ctx.call('GET', `/api/dashboard?accountId=${excluded}`)
  assert.equal(selectedExcluded.data.globalBalance, 33)
  assert.equal(selectedExcluded.data.totalExpense, 7)
  assert.equal(selectedExcluded.data.recentTransactions[0].comment, 'Excluded expense')

  const mainBudget = await ctx.call('POST', '/api/budgets', {
    categoryId: expense.id,
    amount: 100,
    period: 'MONTH'
  })
  const cashBudget = await ctx.call('POST', '/api/budgets', {
    accountId: cash,
    categoryId: expense.id,
    amount: 100,
    period: 'MONTH'
  })
  const excludedBudget = await ctx.call('POST', '/api/budgets', {
    accountId: excluded,
    categoryId: expense.id,
    amount: 100,
    period: 'MONTH'
  })
  assert.equal(mainBudget.status, 201)
  assert.equal(cashBudget.status, 201)
  assert.equal(excludedBudget.status, 201)
  const dashboardBudgets = await ctx.call('GET', '/api/budgets?scope=dashboard&period=MONTH')
  assert.deepEqual(
    dashboardBudgets.data.budgets.map(budget => budget.id).sort(),
    [mainBudget.data.id, cashBudget.data.id].sort()
  )
  const selectedBudgets = await ctx.call(
    'GET',
    `/api/budgets?accountId=${excluded}&period=MONTH`
  )
  assert.deepEqual(selectedBudgets.data.budgets.map(budget => budget.id), [excludedBudget.data.id])
  assert.equal((await ctx.call('GET', '/api/dashboard/summary?accountId=foreign')).status, 404)
  ctx.check('Dashboard Total excludes hidden accounts across lists, totals and budgets', true)
})
