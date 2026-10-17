import assert from 'node:assert/strict'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('tags', async ctx => {
  const { expense } = await createTestUser(ctx)
  const call = async (method, path, body, status = 200) => {
    const result = await ctx.call(method, '/api' + path, body)
    assert.equal(result.status, status, JSON.stringify(result.data))
    return result.data
  }
  for (let i = 0; i < 6; i++) await call('POST', '/tags', { id: `tag-${i}`, name: `Tag ${i}` }, 201)
  await call('POST', '/tags', { id: 'bad', name: ' '.repeat(3) }, 400)
  await call('POST', '/tags', { id: 'bad', name: 'x'.repeat(21) }, 400)
  const alias = await call('POST', '/tags', { id: 'alias', name: ' TAG 0 ' }, 201)
  assert.equal(alias.id, 'tag-0')
  assert.equal((await call('GET', '/tags')).length, 6)
  const body = {
    type: 'EXPENSE',
    amount: 10,
    categoryId: expense.id,
    clientId: 'movement',
    tagIds: ['alias', 'tag-1']
  }
  const movement = await call('POST', '/transactions', body, 201)
  assert.equal(movement.comment, '')
  assert.equal(movement.tags.length, 2)
  await call(
    'POST',
    '/transactions',
    { ...body, clientId: 'too-many', tagIds: Array.from({ length: 6 }, (_, i) => `tag-${i}`) },
    400
  )
  await call('POST', '/transactions', { ...body, clientId: 'bad-tags', tagIds: ['unknown'] }, 400)
  await call('PUT', '/transactions/' + movement.id, { ...body, comment: 'Note', tagIds: [] })
  assert.equal((await call('GET', '/transactions')).items[0].tags.length, 0)
  await call('PUT', '/transactions/' + movement.id, body)
  await call('PUT', '/tags/tag-0', { name: 'Renamed' })
  await call('PUT', '/tags/order', { ids: ['tag-1', 'tag-0'] })
  const rows = (await call('GET', '/transactions')).items
  assert.deepEqual(
    rows[0].tags.map(tag => tag.name),
    ['Tag 1', 'Renamed']
  )
  const dashboard = await call('GET', '/dashboard')
  assert.equal(dashboard.recentTransactions[0].tags[1].name, 'Renamed')
  // Older clients that omit tags preserve their associations.
  await call('PUT', '/transactions/' + movement.id, {
    type: 'EXPENSE',
    amount: 12,
    categoryId: expense.id,
    description: 'Legacy'
  })
  assert.equal((await call('GET', '/transactions')).items[0].tags.length, 2)
  await call('DELETE', '/tags/tag-0')
  assert.equal((await call('GET', '/transactions')).items[0].tags.length, 1)
  const oldToken = ctx.state.token
  await createTestUser(ctx, 'other@example.com')
  await call('PUT', '/tags/tag-1', { name: 'Stolen' }, 404)
  await call('DELETE', '/tags/tag-1', undefined, 404)
  await call('POST', '/tags', { id: 'tag-1', name: 'Stolen' }, 404)
  ctx.state.token = oldToken
  assert.equal((await call('GET', '/tags'))[0].id, 'tag-1')
  console.log(
    'PASS tags: comments, limits, aliases, ordering, legacy updates, global edits and ownership'
  )
})
