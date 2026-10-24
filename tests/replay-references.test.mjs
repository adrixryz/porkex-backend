import assert from 'node:assert/strict'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('replay-references', async ctx => {
  const { expense } = await createTestUser(ctx)
  const category = await ctx.call('POST', '/api/categories', {
    name: 'Temporary',
    type: 'Expense',
    color: '#123456'
  })
  const payload = {
    amount: 12,
    type: 'Expense',
    categoryId: category.data.id,
    clientId: 'movement'
  }
  const created = await ctx.call('POST', '/api/transactions', payload)
  assert.equal(created.status, 201)
  await ctx.call('DELETE', `/api/categories/${category.data.id}?reassignTo=${expense.id}`)
  const replay = await ctx.call('POST', '/api/transactions', payload)
  assert.equal(replay.status, 200)
  assert.equal(replay.data.id, created.data.id)
  assert.equal(replay.data.categoryId, expense.id)
  const rule = await ctx.call('POST', '/api/recurring', {
    amount: 10,
    type: 'Expense',
    categoryId: expense.id,
    frequency: 'MONTH',
    startDate: '2090-01-01',
    clientId: 'rule'
  })
  assert.equal(rule.status, 201)
  assert.equal(
    (await ctx.call('POST', '/api/recurring', { clientId: 'rule', categoryId: -1 })).data.id,
    rule.data.id
  )
  assert.equal(
    (await ctx.call('POST', '/api/transactions', { clientId: 'new', categoryId: -1 })).status,
    400
  )
})
