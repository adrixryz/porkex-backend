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
    type: 'INCOME',
    categoryId: income.id,
    amount: 100
  })
  await ctx.call('POST', '/api/transactions', {
    accountId: cash,
    type: 'EXPENSE',
    categoryId: expense.id,
    amount: 5
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
  assert.equal((await ctx.call('GET', '/api/dashboard/summary?accountId=foreign')).status, 404)
  ctx.check('Selected summaries isolate four indicators while dashboard sections stay global', true)
})
