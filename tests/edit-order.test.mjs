import assert from 'node:assert/strict'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('edit-order', async ctx => {
  const { expense } = await createTestUser(ctx)
  const payload = { amount: 10, type: 'EXPENSE', categoryId: expense.id }
  const created = await ctx.call('POST', '/api/transactions', payload)
  const path = `/api/transactions/${created.data.id}`
  const now = Date.now()
  const older = {
    ...payload,
    amount: 20,
    mutationId: 'a',
    editedAt: new Date(now + 1000).toISOString()
  }
  const newer = {
    ...payload,
    amount: 30,
    mutationId: 'b',
    editedAt: new Date(now + 2000).toISOString()
  }
  assert.equal((await ctx.call('PUT', path, newer)).data.syncStatus, 'applied')
  const delayed = await ctx.call('PUT', path, older)
  assert.equal(delayed.status, 200)
  assert.equal(delayed.data.syncStatus, 'superseded')
  assert.equal(delayed.data.amount, 30)
  assert.equal((await ctx.call('PUT', path, newer)).data.syncStatus, 'applied')
  const tie = await ctx.call('PUT', path, { ...newer, mutationId: 'c', amount: 40 })
  assert.equal(tie.data.amount, 40)
  assert.equal((await ctx.call('PUT', path, newer)).data.amount, 40)
  assert.equal((await ctx.call('PUT', path, { ...payload, mutationId: null })).status, 428)
  assert.equal(
    (await ctx.call('PUT', path, { ...newer, editedAt: new Date(now + 600_000).toISOString() }))
      .status,
    400
  )
  const parallel = await Promise.all([
    ctx.call('PUT', path, { ...older, mutationId: 'parallel-old' }),
    ctx.call('PUT', path, { ...newer, mutationId: 'z', amount: 50 })
  ])
  assert(parallel.every(result => result.status === 200))
  const list = await ctx.call('GET', '/api/transactions')
  assert.equal(list.data.items[0].amount, 50)
})
