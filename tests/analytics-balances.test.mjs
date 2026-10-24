import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('analytics-balances', async ctx => {
  const { user, expense } = await createTestUser(ctx, 'unfunded@example.com')
  const main = `main-${user.id}`
  const cash = randomUUID()
  assert.equal(
    (await ctx.call('PUT', `/api/accounts/${main}`, { openingBalance: 100 })).status,
    200
  )
  assert.equal(
    (
      await ctx.call('POST', '/api/accounts', {
        id: cash,
        name: 'Cash',
        openingBalance: 50
      })
    ).status,
    201
  )
  assert.equal(
    (
      await ctx.call('POST', '/api/transactions', {
        accountId: cash,
        type: 'Expense',
        categoryId: expense.id,
        amount: 10
      })
    ).status,
    201
  )
  const initial = await ctx.call('GET', '/api/analytics?months=3&days=7')
  assert.equal(initial.status, 200)
  assert.equal(initial.data.trendData.at(-1).balance, 140)
  assert.equal(
    (
      await ctx.call('PUT', `/api/accounts/${cash}`, {
        balance: 25,
        mutationId: randomUUID()
      })
    ).status,
    200
  )
  const corrected = await ctx.call('GET', '/api/analytics?months=3&days=7')
  const dashboard = await ctx.call('GET', '/api/dashboard')
  assert.equal(corrected.data.trendData.at(-1).balance, 125)
  assert.equal(corrected.data.trendData.at(-1).balance, dashboard.data.globalBalance)
  assert.equal(corrected.data.insights.currentMonthExpense, 10)
  ctx.check(
    'Analytics balance includes account openings and corrections without inflating spending',
    true
  )
  for (const [date, amount] of [
    ['2024-01-01', 50],
    ['2024-02-01', 100],
    ['2024-03-01', 150],
    ['2024-04-01', 75]
  ]) {
    assert.equal(
      (await ctx.call('PUT', `/api/accounts/${main}`, { openingBalance: 1000 })).status,
      200
    )
    assert.equal(
      (
        await ctx.call('POST', '/api/transactions', {
          accountId: main,
          type: 'Expense',
          categoryId: expense.id,
          amount,
          date
        })
      ).status,
      201
    )
  }
  for (const [today, expected] of [
    ['2024-03-06', 50],
    ['2024-04-06', -50],
    ['2024-01-06', null],
    ['2023-12-06', 0]
  ]) {
    const result = await ctx.call('GET', `/api/analytics?months=3&days=7&today=${today}`)
    assert.equal(result.status, 200)
    assert.equal(result.data.insights.expenseChangePercent, expected)
  }
  ctx.check(
    'Month-over-Month covers increases, decreases, no previous spending and empty periods',
    true
  )
})
