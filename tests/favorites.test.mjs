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
    type: 'Expense',
    amount: 12.5,
    comment: 'Lunch',
    tagIds: []
  }
  const created = await ctx.call('POST', '/api/favorites', payload)
  assert.equal(created.status, 201, JSON.stringify(created.data))
  assert.equal((await ctx.call('POST', '/api/favorites', payload)).data.id, payload.id)
  for (const name of ['lunch', ' LUNCH ']) {
    const duplicate = await ctx.call('POST', '/api/favorites', {
      ...payload,
      id: randomUUID(),
      name
    })
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.data))
  }
  const secondId = randomUUID()
  assert.equal(
    (await ctx.call('POST', '/api/favorites', { ...payload, id: secondId, name: 'Other meal' }))
      .status,
    201
  )
  assert.equal(
    (await ctx.call('PUT', `/api/favorites/${secondId}`, { ...payload, name: 'Lunch' })).status,
    409
  )
  await ctx.call('DELETE', `/api/favorites/${secondId}`)
  const accentId = randomUUID()
  assert.equal(
    (await ctx.call('POST', '/api/favorites', { ...payload, id: accentId, name: 'Caf\u00e9' }))
      .status,
    201
  )
  assert.equal(
    (
      await ctx.call('POST', '/api/favorites', {
        ...payload,
        id: randomUUID(),
        name: ' CAFE\u0301 '
      })
    ).status,
    409
  )
  await ctx.call('DELETE', `/api/favorites/${accentId}`)

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
