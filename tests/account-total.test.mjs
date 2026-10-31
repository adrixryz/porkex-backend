import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('account-total', async ctx => {
  const { user, income, expense } = await createTestUser(ctx, 'total@example.test')
  const ownerToken = ctx.state.token
  const main = `main-${user.id}`
  const request = async (method, path, body, expected = 200) => {
    const result = await ctx.call(method, `/api${path}`, body)
    assert.equal(result.status, expected, JSON.stringify(result.data))
    return result.data
  }
  const edit = body => ({ ...body, mutationId: randomUUID(), editedAt: new Date().toISOString() })
  await request('PUT', `/accounts/${main}`, edit({ balance: 1000 }))
  const cash = await request(
    'POST',
    '/accounts',
    {
      id: 'excluded-cash',
      name: 'Cash',
      openingBalance: 200,
      excludeFromTotalBalance: true
    },
    201
  )
  assert.equal(cash.excludeFromTotalBalance, true)
  await request(
    'POST',
    '/transfers',
    {
      id: 'to-excluded',
      sourceId: main,
      destinationId: cash.id,
      amount: 100,
      date: '2026-01-01',
      comment: ''
    },
    201
  )
  for (const [type, amount, categoryId] of [
    ['Income', 50, income.id],
    ['Expense', 25, expense.id]
  ])
    await request(
      'POST',
      '/transactions',
      {
        clientId: randomUUID(),
        accountId: cash.id,
        type,
        amount,
        categoryId,
        date: '2026-01-01',
        comment: ''
      },
      201
    )
  let dashboard = await request('GET', '/dashboard')
  assert.equal(dashboard.globalBalance, 900)
  assert.equal(dashboard.totalIncome, 0, 'Excluded accounts do not affect Dashboard Total')
  assert.equal(dashboard.totalExpense, 0)
  assert.equal(dashboard.transactionCount, 0)
  assert.equal((await request('GET', `/dashboard?accountId=${cash.id}`)).globalBalance, 325)
  assert.equal((await request('GET', '/dashboard/summary')).globalBalance, 900)
  await request('PUT', `/accounts/${cash.id}`, edit({ name: 'Cash renamed' }))
  assert.equal(
    (await request('GET', '/accounts')).find(row => row.id === cash.id).excludeFromTotalBalance,
    true
  )
  await request('PUT', `/accounts/${cash.id}`, edit({ excludeFromTotalBalance: false }))
  assert.equal((await request('GET', '/dashboard')).globalBalance, 1225)
  await request('PUT', `/accounts/${cash.id}`, edit({ excludeFromTotalBalance: true }))
  await request('POST', '/goals', { id: 'total-goal', name: 'Vacation', targetAmount: 500 }, 201)
  await request(
    'POST',
    '/transfers',
    {
      id: 'to-goal',
      sourceId: main,
      destinationId: 'total-goal',
      amount: 100,
      date: '2026-01-01',
      comment: ''
    },
    201
  )
  assert.equal(
    (await request('GET', '/dashboard')).globalBalance,
    900,
    'Goals remain part of Total'
  )
  await request('PUT', `/accounts/${main}`, edit({ excludeFromTotalBalance: true }))
  assert.equal((await request('GET', '/dashboard')).globalBalance, 100)
  for (const invalid of ['true', 1, null]) {
    await request('PUT', `/accounts/${cash.id}`, edit({ excludeFromTotalBalance: invalid }), 400)
    await request('POST', '/accounts', { name: 'Invalid', excludeFromTotalBalance: invalid }, 400)
  }
  await createTestUser(ctx, 'other-total@example.test')
  await request('PUT', `/accounts/${cash.id}`, edit({ excludeFromTotalBalance: false }), 404)
  ctx.state.token = ownerToken
  dashboard = await request('GET', '/dashboard')
  assert.equal(dashboard.globalBalance, 100, 'Other users cannot change this total')
  console.log(
    'PASS account Total exclusion: defaults, edits, transfers, legacy Main, goals, validation and ownership'
  )
})
