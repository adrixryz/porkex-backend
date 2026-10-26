import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'
await withServer('yearly-budgets', async ctx => {
  const { user, expense } = await createTestUser(ctx)
  const main = `main-${user.id}`
  const request = async (method, path, body, expected = 200) => {
    const result = await ctx.call(method, `/api${path}`, body)
    assert.equal(result.status, expected, JSON.stringify(result.data))
    return result.data
  }
  const cash = await request(
    'POST',
    '/accounts',
    { id: randomUUID(), name: 'Cash', openingBalance: 100 },
    201
  )
  for (const [date, amount] of [
    ['2023-12-31', 10],
    ['2024-01-01', 20],
    ['2024-02-29', 30],
    ['2024-12-31', 40],
    ['2025-01-01', 50]
  ])
    await request(
      'POST',
      '/transactions',
      {
        clientId: randomUUID(),
        accountId: main,
        categoryId: expense.id,
        type: 'Expense',
        amount,
        date,
        comment: ''
      },
      201
    )
  await request(
    'POST',
    '/transactions',
    {
      clientId: randomUUID(),
      accountId: cash.id,
      categoryId: expense.id,
      type: 'Expense',
      amount: 15,
      date: '2024-02-29',
      comment: ''
    },
    201
  )
  const saved = []
  for (const period of ['WEEK', 'MONTH', 'YEAR'])
    saved.push(
      await request(
        'POST',
        '/budgets',
        { clientId: randomUUID(), accountId: main, categoryId: expense.id, amount: 1000, period },
        201
      )
    )
  await request(
    'POST',
    '/budgets',
    {
      clientId: randomUUID(),
      accountId: cash.id,
      categoryId: expense.id,
      amount: 500,
      period: 'YEAR'
    },
    201
  )
  let result = await request('GET', '/budgets?period=YEAR&today=2024-02-29')
  assert.deepEqual(
    result.budgets.map(budget => budget.spent),
    [90, 15]
  )
  assert.equal(result.totals[0].spent, 105)
  assert.equal((await request('GET', '/budgets?period=YEAR&today=2025-01-01')).budgets[0].spent, 50)
  assert.equal((await request('GET', '/budgets?period=YEAR&today=2026-01-01')).budgets[0].spent, 0)
  assert.equal(
    (await request('GET', '/budgets?period=MONTH&today=2024-02-29')).budgets[0].spent,
    30
  )
  assert.equal(
    (await request('GET', '/budgets?period=WEEK&today=2024-02-29&weekStart=MONDAY')).budgets[0]
      .spent,
    30
  )
  await request(
    'POST',
    '/budgets',
    { clientId: randomUUID(), accountId: main, categoryId: expense.id, amount: 10, period: 'YEAR' },
    409
  )
  const backup = await request('GET', '/backup')
  assert.equal(backup.tables.Budget.filter(row => row.period === 'YEAR').length, 2)
  await request('POST', '/backup/preview', { backup })
  await request('PUT', `/budgets/${saved[2].id}`, { amount: 2000, period: 'YEAR' })
  result = await request('GET', `/budgets?period=YEAR&today=2024-02-29&accountId=${main}`)
  assert.equal(result.budgets[0].amount, 2000)
  await request('DELETE', `/budgets/${saved[2].id}`)
  assert.equal((await request('GET', `/budgets?period=YEAR&accountId=${main}`)).budgets.length, 0)
  console.log(
    'Yearly budgets: leap-year bounds, annual reset, account isolation, uniqueness, editing and JSON backup passed.'
  )
})
