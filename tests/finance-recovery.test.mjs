import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('finance-recovery', async ctx => {
  const { user, income, expense, categories } = await createTestUser(ctx, 'unfunded@example.com')
  const main = `main-${user.id}`
  const today = new Date().toISOString().slice(0, 10)
  const request = async (method, path, body, expected = 200) => {
    const result = await ctx.call(method, '/api' + path, body)
    assert.equal(result.status, expected, JSON.stringify(result.data))
    return result.data
  }
  await request('PUT', `/accounts/${main}`, { balance: 100 })
  const cash = randomUUID()
  await request('POST', '/accounts', { id: cash, name: 'Cash', openingBalance: 0 }, 201)
  const transfer = randomUUID()
  const payload = { sourceId: main, destinationId: cash, amount: 10, date: today, comment: '' }
  await request('POST', '/transfers', { ...payload, id: transfer }, 201)
  const newer = { mutationId: randomUUID(), editedAt: new Date(Date.now() + 1000).toISOString() }
  await request('PUT', `/transfers/${transfer}`, { ...payload, ...newer, amount: 30 })
  await request(
    'PUT',
    `/transfers/${transfer}`,
    {
      ...payload,
      mutationId: randomUUID(),
      editedAt: new Date(Date.now() - 1000).toISOString(),
      amount: 20
    },
    409
  )
  assert.equal((await request('GET', '/transfers')).items[0].amount, 30)
  await request('PUT', `/transfers/${transfer}`, { ...payload, ...newer, amount: 30 })
  assert.equal((await request('GET', '/accounts')).find(row => row.id === cash).balance, 30)
  ctx.check('Delayed transfer edits conflict and exact replays never change balances twice', true)

  await request('PUT', `/accounts/${cash}`, { name: 'New name', ...newer })
  await request(
    'PUT',
    `/accounts/${cash}`,
    {
      name: 'Old name',
      mutationId: randomUUID(),
      editedAt: new Date(Date.now() - 1000).toISOString()
    },
    409
  )
  const goal = randomUUID()
  await request('POST', '/goals', { id: goal, name: 'Goal', targetAmount: 100 }, 201)
  await request('PUT', `/goals/${goal}`, { name: 'New goal', targetAmount: 200, ...newer })
  await request(
    'PUT',
    `/goals/${goal}`,
    {
      name: 'Old goal',
      targetAmount: 100,
      mutationId: randomUUID(),
      editedAt: new Date(Date.now() - 1000).toISOString()
    },
    409
  )
  ctx.check('Accounts and goals preserve the newer saved intent', true)

  const before = (await request('GET', '/analytics?days=7')).trendData
  await request('PUT', `/accounts/${main}`, { balance: 200 })
  const after = (await request('GET', '/analytics?days=7')).trendData
  assert.deepEqual(after.slice(0, -1), before.slice(0, -1))
  assert.equal(after.at(-1).balance, 230)
  assert.equal(after.at(-1).balance, (await request('GET', '/dashboard')).globalBalance)
  ctx.check('A current correction changes today and preserves earlier balances', true)

  await request(
    'POST',
    '/budgets',
    { categoryId: income.id, accountId: main, amount: 10, period: 'MONTH' },
    400
  )
  await request(
    'POST',
    '/budgets',
    { categoryId: expense.id, accountId: main, amount: 10, period: 'MONTH' },
    201
  )
  await request('PUT', `/categories/${expense.id}`, { ...expense, type: 'Income' }, 409)
  ctx.check('Spending budgets reject income and protect linked category types', true)

  const tag = randomUUID(),
    favorite = randomUUID()
  await request('POST', '/tags', { id: tag, name: 'Personal' }, 201)
  const template = {
    id: favorite,
    name: 'Lunch',
    amount: 1,
    accountId: main,
    categoryId: expense.id,
    type: 'Expense',
    tagIds: [tag]
  }
  await request('POST', '/favorites', template, 201)
  await request('PUT', `/favorites/${favorite}`, { ...template, name: 'New favorite', ...newer })
  await request(
    'PUT',
    `/favorites/${favorite}`,
    {
      ...template,
      name: 'Old favorite',
      mutationId: randomUUID(),
      editedAt: new Date(Date.now() - 1000).toISOString()
    },
    409
  )
  await request('DELETE', `/tags/${tag}`)
  let saved = (await request('GET', '/favorites')).find(row => row.id === favorite)
  assert.deepEqual(saved.tagIds, [])
  await request('POST', '/transactions', { ...saved, clientId: randomUUID(), date: today }, 201)
  const replacement = categories.find(row => row.type === 'Expense' && row.id !== expense.id)
  await request('DELETE', `/categories/${expense.id}?reassignTo=${replacement.id}`)
  saved = (await request('GET', '/favorites')).find(row => row.id === favorite)
  assert.equal(saved.categoryId, replacement.id)
  const emptyCategory = await request(
    'POST',
    '/categories',
    { name: 'Unused template', type: 'Expense' },
    201
  )
  await request(
    'POST',
    '/favorites',
    { ...template, id: randomUUID(), categoryId: emptyCategory.id, tagIds: [] },
    201
  )
  await request('DELETE', `/categories/${emptyCategory.id}`)
  assert.equal((await request('GET', '/favorites')).length, 1)
  ctx.check(
    'Favorite edits are ordered; deleted tags and deleted or reassigned categories leave no broken templates',
    true
  )

  {
    const isolated = randomUUID()
    await request('POST', '/accounts', { id: isolated, name: 'Recurring', openingBalance: 0 }, 201)
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
    const makeRule = (type, categoryId, amount) =>
      request(
        'POST',
        '/recurring',
        {
          type,
          categoryId,
          accountId: isolated,
          amount,
          frequency: 'DAY',
          interval: 1,
          startDate: tomorrow
        },
        201
      )
    const expenseRule = await makeRule('Expense', replacement.id, 5)
    const incomeRule = await makeRule('Income', income.id, 10)
    for (const rule of [expenseRule, incomeRule]) {
      const aged = spawnSync(
        process.execPath,
        [
          'tests/db-cli.mjs',
          'age',
          `file:${ctx.dbFile.replace(/\\/g, '/')}`,
          String(rule.id),
          today
        ],
        { encoding: 'utf8' }
      )
      assert.equal(aged.status, 0, aged.stderr)
    }
    const result = await ctx.call('GET', `/api/dashboard?accountId=${isolated}`)
    assert.equal(result.data.globalBalance, 5)
    assert.equal(result.headers.get('X-Porkex-Recurring-State'), 'ready')
    assert.equal((await request('GET', '/accounts')).find(row => row.id === isolated).balance, 5)
    ctx.check('Due income funds due expenses in the same materialization pass', true)
    for (let index = 0; index < 20; index++)
      await request('PUT', `/accounts/${main}`, {
        balance: 201 + index,
        mutationId: `page-${index.toString().padStart(2, '0')}`,
        editedAt: new Date(Date.now() + 2000 + index).toISOString()
      })
    const first = await request('GET', `/accounts/movements?accountId=${main}&page=1`)
    const second = await request('GET', `/accounts/movements?accountId=${main}&page=2`)
    assert.equal(first.items.length, 15)
    assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, first.total)
    assert.equal(first.items[0].id, 'account:edit:page-19')
    assert.equal((await request('GET', '/accounts/movements?accountId=foreign')).total, 0)
    ctx.check('Combined history pages are stable, complete and account scoped', true)
  }
})
