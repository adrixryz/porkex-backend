import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('accounts', async ctx => {
  const { user, income, expense } = await createTestUser(ctx, 'unfunded@example.com')
  const main = `main-${user.id}`
  const call = async (method, path, body, status = 200) => {
    const result = await ctx.call(method, '/api' + path, body)
    assert.equal(result.status, status, JSON.stringify(result.data))
    return result.data
  }
  assert.equal((await call('GET', '/accounts'))[0].balance, 0)
  const movement = (type, amount, categoryId) => ({
    clientId: randomUUID(),
    accountId: main,
    type,
    amount,
    categoryId,
    comment: ''
  })
  await call('POST', '/transactions', movement('Expense', 1, expense.id), 409)
  const funding = await call('POST', '/transactions', movement('Income', 100, income.id), 201)
  const destinationId = randomUUID()
  await call('POST', '/accounts', { id: destinationId, name: 'Cash', openingBalance: 0 }, 201)
  const transfer = {
    id: randomUUID(),
    sourceId: main,
    destinationId,
    amount: 40,
    date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }),
    comment: ''
  }
  await call('POST', '/transfers', transfer, 201)
  await call('POST', '/transfers', transfer, 201)
  assert.equal((await call('GET', '/accounts')).find(a => a.id === main).balance, 60)
  await call('DELETE', `/transactions/${funding.id}`, undefined, 409)
  await call('PUT', `/transfers/${transfer.id}`, {
    ...transfer,
    amount: 30,
    mutationId: randomUUID()
  })
  await call('DELETE', `/transfers/${transfer.id}`)
  await call('POST', '/transfers', transfer, 201)
  assert.equal(
    (await call('GET', '/transfers')).items.length,
    0,
    'A deleted transfer cannot be recreated by a lost-response replay'
  )
  await call('DELETE', `/transactions/${funding.id}`)
  await call(
    'POST',
    '/transactions',
    { ...movement('Income', 100, income.id), clientId: funding.clientId },
    201
  )
  assert.equal(
    (await call('GET', '/accounts')).find(a => a.id === main).balance,
    0,
    'Movement receipt survives deletion'
  )
  await call('PUT', `/accounts/${main}`, { archived: true }, 400)
  await call('POST', '/transfers', { ...transfer, id: randomUUID(), amount: 1 }, 409)
  await call('PUT', `/accounts/${destinationId}`, { archived: true, openingBalance: 1 }, 409)
  assert.equal((await call('GET', '/accounts')).find(a => a.id === destinationId).archived, false)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
  const rule = await call(
    'POST',
    '/recurring',
    {
      clientId: randomUUID(),
      accountId: main,
      amount: 10,
      type: 'Expense',
      categoryId: expense.id,
      description: 'Blocked expense',
      startDate: today,
      frequency: 'DAY',
      interval: 1
    },
    201
  )
  assert.equal(
    rule.nextDate.slice(0, 10),
    today,
    'Insufficient funds must not advance the occurrence'
  )
  const blocked = await ctx.call('GET', '/api/dashboard')
  assert.equal(blocked.headers.get('x-porkex-recurring-state'), 'blocked')
  await call('POST', '/transactions', movement('Income', 100, income.id), 201)
  await call('GET', '/dashboard')
  const rules = await call('GET', '/recurring')
  assert(rules.find(r => r.id === rule.id).nextDate.slice(0, 10) > today)
  assert.equal((await call('GET', '/accounts')).find(a => a.id === main).balance, 90)
  const racing = await Promise.all(
    [1, 2].map(() =>
      ctx.call('POST', '/api/transfers', { ...transfer, id: randomUUID(), amount: 80 })
    )
  )
  assert.deepEqual(
    racing.map(r => r.status).sort(),
    [201, 409],
    'Concurrent debits cannot overdraw funds'
  )
  assert.equal((await call('GET', '/accounts')).find(a => a.id === main).balance, 10)
  ctx.check('Account funds, transfers, rollback and durable replay protection', true)
})
