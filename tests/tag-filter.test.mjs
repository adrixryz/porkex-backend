import assert from 'node:assert/strict'
import { withServer, createTestUser } from './helpers.mjs'
await withServer('tag-filter', async ctx => {
  const { expense } = await createTestUser(ctx)
  await ctx.call('POST', '/api/tags', { id: 'food', name: 'Food' })
  await ctx.call('POST', '/api/tags', { id: 'alias', name: 'Food' })
  for (let i = 0; i < 3; i++) {
    const r = await ctx.call('POST', '/api/transactions', {
      type: 'Expense',
      categoryId: expense.id,
      amount: i + 1,
      comment: 'Lunch',
      tagIds: i < 2 ? ['food'] : []
    })
    assert.equal(r.status, 201)
  }
  const filtered = await ctx.call(
    'GET',
    '/api/transactions?tagId=alias&search=Lunch&type=Expense&min=2&perPage=1&page=3'
  )
  assert.equal(filtered.status, 200)
  assert.equal(filtered.data.total, 1)
  assert.equal(filtered.data.page, 1)
  assert.equal(filtered.data.items[0].amount, 2)
  assert.equal((await ctx.call('GET', '/api/transactions?tagId=missing')).data.total, 0)
  assert.equal((await ctx.call('GET', '/api/transactions?tagId[]=food')).status, 400)
  ctx.check(
    'Single-tag filtering combines with search, amounts and pagination and resolves aliases',
    true
  )
})
