import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('favorites', async ctx => {
  const { user, expense } = await createTestUser(ctx)
  const payload = {
    id: randomUUID(),
    name: 'Lunch',
    accountId: `main-${user.id}`,
    categoryId: expense.id,
    type: 'EXPENSE',
    amount: 12.5,
    comment: 'Lunch',
    tagIds: []
  }
  const created = await ctx.call('POST', '/api/favorites', payload)
  assert.equal(created.status, 201, JSON.stringify(created.data))
  assert.equal((await ctx.call('POST', '/api/favorites', payload)).data.id, payload.id)
  assert.equal(
    (await ctx.call('GET', '/api/transactions')).data.total,
    0,
    'A favorite never records a movement'
  )
  const movement = await ctx.call('POST', '/api/transactions', {
    ...payload,
    clientId: randomUUID()
  })
  assert.equal(movement.status, 201)
  await ctx.call('DELETE', `/api/transactions/${movement.data.id}`)
  assert.equal((await ctx.call('GET', '/api/favorites')).data[0].amount, 12.5)
  assert.equal(
    (
      await ctx.call('PUT', `/api/favorites/${payload.id}`, {
        ...payload,
        name: 'Coffee',
        amount: 5
      })
    ).status,
    200
  )
  assert.equal((await ctx.call('DELETE', `/api/favorites/${payload.id}`)).status, 200)
  assert.equal((await ctx.call('GET', '/api/favorites')).data.length, 0)
  ctx.check(
    'Favorites are independent, editable templates and never register movements automatically',
    true
  )
})
