import assert from 'node:assert/strict'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('catalog-clientid', async ctx => {
  const { expense } = await createTestUser(ctx)
  for (const [path, body] of [
    ['/api/categories', { name: 'Replay', type: 'Expense', color: '#123456' }],
    ['/api/budgets', { categoryId: expense.id, amount: 55, period: 'MONTH' }]
  ]) {
    const payload = { ...body, clientId: 'catalog-request' }
    const first = await ctx.call('POST', path, payload)
    assert.equal(first.status, 201)
    const replay = await ctx.call('POST', path, { clientId: payload.clientId })
    assert.equal(replay.status, 200)
    assert.equal(replay.data.id, first.data.id)
    if (path.endsWith('budgets')) assert.equal(replay.data.amount, 55)
    assert.equal((await ctx.call('POST', path, { ...body, clientId: 'different' })).status, 409)
    assert.equal((await ctx.call('POST', path, { ...body, clientId: 'bad id' })).status, 400)
  }
})
