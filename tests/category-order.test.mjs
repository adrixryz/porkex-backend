import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('category-order', async ctx => {
  const { categories } = await createTestUser(ctx, 'order@example.test')
  const token = ctx.state.token
  const request = async (method, path, body, expected = 200) => {
    const result = await ctx.call(method, `/api${path}`, body)
    assert.equal(result.status, expected, JSON.stringify(result.data))
    return result.data
  }
  const edit = ids => ({ ids, editedAt: new Date().toISOString(), mutationId: randomUUID() })
  const expense = categories
    .filter(category => category.type === 'Expense')
    .map(category => category.id)
  const reverse = [...expense].reverse()
  const intent = edit(reverse)
  await request('PUT', '/categories/order', intent)
  let saved = await request('GET', '/categories')
  assert.deepEqual(
    saved.filter(category => category.type === 'Expense').map(category => category.id),
    reverse
  )
  for (const [index, category] of categories.entries()) {
    if (category.type === 'Income')
      assert.equal(saved[index].id, category.id, 'Other type keeps its slots')
  }
  await request('PUT', '/categories/order', intent)
  assert.deepEqual(
    (await request('GET', '/categories')).map(category => category.id),
    saved.map(category => category.id)
  )
  await request(
    'PUT',
    '/categories/order',
    { ...edit(expense), editedAt: '2020-01-01T00:00:00.000Z' },
    409
  )
  for (const ids of [[expense[0], expense[0]], [], [0], ['1'], [2147483648]])
    await request('PUT', '/categories/order', edit(ids), 400)
  await request('PUT', '/categories/order', { ids: expense, editedAt: '', mutationId: '' }, 428)
  await request('PUT', '/categories/order', edit([expense[0], 2147483647]), 409)
  await createTestUser(ctx, 'other-order@example.test')
  await request('PUT', '/categories/order', edit(expense), 409)
  ctx.state.token = token
  assert.deepEqual(
    (await request('GET', '/categories')).map(category => category.id),
    saved.map(category => category.id),
    'Invalid or foreign writes are atomic'
  )
  const created = await request(
    'POST',
    '/categories',
    { name: 'Added last', type: 'Expense', color: '#EA4335', clientId: randomUUID() },
    201
  )
  saved = await request('GET', '/categories')
  assert.equal(saved.at(-1).id, created.id, 'New categories append after saved order')
  console.log('Category ordering, ownership, partial lists, validation and stale edits passed.')
})
