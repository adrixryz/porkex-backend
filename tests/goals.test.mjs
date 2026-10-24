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
  await call('POST', '/transactions', { type: 'Income', amount: 100, categoryId: income.id }, 201)
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
  const transferAccounts = await call('GET', '/accounts?includeGoals=true')
  const goalOption = transferAccounts.find(account => account.id === goalId)
  assert.equal(transferAccounts.length, 2)
  assert.equal(goalOption.isGoal, true)
  assert.equal(goalOption.name, 'Vacation')
  assert.equal(goalOption.balance, 40)
  assert.equal(goalOption.targetAmount, 800)
  assert.equal((await call('GET', '/dashboard')).globalBalance, 100)
  await call(
    'POST',
    '/transactions',
    { type: 'Income', amount: 10, categoryId: income.id, accountId: goalId },
    400
  )
  await call('DELETE', `/goals/${goalId}`, undefined, 409)
  await call(
    'PUT',
    `/goals/${goalId}`,
    {
      name: 'Vacation',
      targetAmount: 39,
      mutationId: randomUUID()
    },
    409
  )
  await call('PUT', `/goals/${goalId}`, {
    name: 'Vacation',
    targetAmount: 50,
    mutationId: randomUUID()
  })
  await call('POST', '/transfers', { ...transfer, id: randomUUID(), amount: 11 }, 409)
  const topup = { ...transfer, id: randomUUID(), amount: 10 }
  await call('POST', '/transfers', topup, 201)
  await call('POST', '/transfers', { ...transfer, id: randomUUID(), amount: 0.01 }, 409)
  await call(
    'PUT',
    `/transfers/${topup.id}`,
    {
      ...topup,
      amount: 11,
      mutationId: randomUUID()
    },
    409
  )
  const withdrawal = {
    ...transfer,
    id: randomUUID(),
    sourceId: goalId,
    destinationId: main,
    amount: 5
  }
  await call('POST', '/transfers', withdrawal, 201)
  const refill = { ...transfer, id: randomUUID(), amount: 5 }
  await call('POST', '/transfers', refill, 201)
  await call('DELETE', `/transfers/${withdrawal.id}`, undefined, 409)
  assert.equal((await call('GET', '/goals'))[0].balance, 50)
  await call('DELETE', `/transfers/${refill.id}`)
  await call('DELETE', `/transfers/${withdrawal.id}`)
  await call('DELETE', `/transfers/${topup.id}`)
  assert.equal((await call('GET', '/goals'))[0].balance, 40)
  ctx.check(
    'Goals reject excess funding, lower targets and reversing withdrawals beyond the target',
    true
  )
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
