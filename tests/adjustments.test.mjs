import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('adjustments', async ctx => {
  const { expense } = await createTestUser(ctx, 'unfunded@example.com')
  const call = async (method, path, body, status = 200) => {
    const result = await ctx.call(method, '/api' + path, body)
    assert.equal(result.status, status, JSON.stringify(result.data))
    return result.data
  }
  const cash = randomUUID()
  await call('POST', '/accounts', { id: cash, name: 'Cash', openingBalance: 100 }, 201)
  const editId = randomUUID()
  await call('PUT', `/accounts/${cash}`, { balance: 150, mutationId: editId })
  const path = `/accounts/balance-adjustments/${encodeURIComponent(`account:edit:${editId}`)}`
  const original = (await call('GET', `/accounts/movements?accountId=${cash}`)).items[0]
  const edit = { balance: 180, mutationId: randomUUID() }
  await call('PUT', path, edit)
  await call('PUT', path, edit)
  assert.equal((await call('GET', '/accounts')).find(a => a.id === cash).balance, 180)
  const changed = (await call('GET', `/accounts/movements?accountId=${cash}`)).items[0]
  assert.equal(changed.balance, 180)
  assert.equal(changed.createdAt, original.createdAt)
  await call('DELETE', path)
  await call('DELETE', path)
  assert.equal((await call('GET', '/accounts')).find(a => a.id === cash).balance, 100)
  assert.equal((await call('GET', `/accounts/movements?accountId=${cash}`)).items.length, 1)
  ctx.check(
    'Adjustment edits and deletion reverse only their own effect and preserve replay safety and creation order',
    true
  )

  const openingPath = `/accounts/balance-adjustments/${encodeURIComponent(`account:create:${cash}`)}`
  await call(
    'POST',
    '/transactions',
    { accountId: cash, type: 'Expense', amount: 80, categoryId: expense.id },
    201
  )
  await call('DELETE', openingPath, undefined, 409)
  await call('PUT', openingPath, { balance: 70, mutationId: randomUUID() }, 409)
  assert.equal((await call('GET', '/accounts')).find(a => a.id === cash).balance, 20)
  assert.equal((await call('GET', `/accounts/movements?accountId=${cash}`)).items[0].balance, 100)
  ctx.check('Insufficient funds roll back both the balance and its history entry', true)

  const retired = randomUUID()
  const retirement = randomUUID()
  await call('POST', '/accounts', { id: retired, name: 'Retired', openingBalance: 20 }, 201)
  await call('PUT', `/accounts/${retired}`, { balance: 0, mutationId: retirement })
  await call('PUT', `/accounts/${retired}`, { archived: true, mutationId: randomUUID() })
  await call('DELETE', `/accounts/${retired}`)
  const retiredPath = `/accounts/balance-adjustments/${encodeURIComponent(`account:create:${retired}`)}`
  await call('PUT', retiredPath, { balance: 30, mutationId: randomUUID() }, 404)
  await call('DELETE', retiredPath)
  assert.equal((await call('GET', `/accounts/movements?accountId=${retired}`)).total, 1)
  const owner = ctx.state.token
  await createTestUser(ctx, 'other-owner@example.com')
  await call('DELETE', openingPath, undefined, 404)
  await call('PUT', openingPath, { balance: 120, mutationId: randomUUID() }, 404)
  assert.equal((await call('GET', `/accounts/movements?accountId=${cash}`)).total, 0)
  ctx.state.token = owner
  assert.equal((await call('GET', '/accounts')).find(a => a.id === cash).balance, 20)
  ctx.check(
    'Removed accounts allow history deletion only; foreign owners cannot edit or delete adjustments',
    true
  )
})
