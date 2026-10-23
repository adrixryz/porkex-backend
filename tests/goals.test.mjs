import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('goals', async ctx => {
  const { user, income } = await createTestUser(ctx, 'unfunded@example.com')
  const main = `main-${user.id}`,
    goalId = randomUUID()
  const call = async (method, path, body, status = 200) => {
    const r = await ctx.call(method, '/api' + path, body)
    assert.equal(r.status, status, JSON.stringify(r.data))
    return r.data
  }
  await call('POST', '/transactions', { type: 'INCOME', amount: 100, categoryId: income.id }, 201)
  await call('POST', '/goals', { id: goalId, name: 'Vacation', targetAmount: 800 }, 201)
  const transfer = {
    id: randomUUID(),
    sourceId: main,
    destinationId: goalId,
    amount: 40,
    date: '2024-01-01',
    comment: 'Savings'
  }
  await call('POST', '/transfers', transfer, 201)
  assert.equal((await call('GET', '/goals'))[0].balance, 40)
  assert.equal((await call('GET', '/accounts')).length, 1)
  assert.equal((await call('GET', '/dashboard')).globalBalance, 100)
  await call(
    'POST',
    '/transactions',
    { type: 'INCOME', amount: 10, categoryId: income.id, accountId: goalId },
    400
  )
  await call('DELETE', `/goals/${goalId}`, undefined, 409)
  await call(
    'POST',
    '/transfers',
    { ...transfer, id: randomUUID(), sourceId: goalId, destinationId: main },
    201
  )
  await call('DELETE', `/goals/${goalId}`)
  assert.equal((await call('GET', '/transfers')).total, 2)
  assert.equal((await call('GET', '/goals')).length, 0)
  ctx.check(
    'Goal funding preserves global funds, blocks direct movements and retains transfer history',
    true
  )
})
