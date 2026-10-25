import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('audit-recovery', async ctx => {
  const { user, expense, income } = await createTestUser(ctx, 'unfunded@example.com')
  const main = `main-${user.id}`
  const day = new Date().toISOString().slice(0, 10)
  const stamp = offset => ({
    mutationId: randomUUID(),
    editedAt: new Date(Date.now() + offset).toISOString()
  })
  const request = async (method, path, body, status = 200) => {
    const result = await ctx.call(method, '/api' + path, body)
    assert.equal(result.status, status, JSON.stringify(result.data))
    return result.data
  }
  const newer = stamp(1000),
    older = stamp(-1000)
  const budget = await request(
    'POST',
    '/budgets',
    { accountId: main, categoryId: expense.id, amount: 50, period: 'MONTH' },
    201
  )
  await request('PUT', `/budgets/${budget.id}`, { amount: 200, period: 'MONTH', ...newer })
  await request('PUT', `/budgets/${budget.id}`, { amount: 100, period: 'MONTH', ...older }, 409)
  assert.equal((await request('GET', '/budgets')).budgets[0].amount, 200)
  await request('PUT', `/categories/${expense.id}`, {
    ...expense,
    name: 'Latest category',
    ...newer
  })
  await request(
    'PUT',
    `/categories/${expense.id}`,
    { ...expense, name: 'Old category', ...older },
    409
  )
  const rule = await request(
    'POST',
    '/recurring',
    {
      accountId: main,
      type: 'Expense',
      categoryId: expense.id,
      amount: 1,
      frequency: 'MONTH',
      startDate: '2099-01-01'
    },
    201
  )
  const ruleEdit = {
    accountId: main,
    type: 'Expense',
    categoryId: expense.id,
    amount: 2,
    frequency: 'MONTH',
    startDate: '2099-01-01'
  }
  await request('PUT', `/recurring/${rule.id}`, { ...ruleEdit, ...newer })
  await request('PUT', `/recurring/${rule.id}`, { ...ruleEdit, amount: 3, ...older }, 409)
  await request('PUT', '/profile', { name: 'Latest name', ...newer })
  await request('PUT', '/profile', { name: 'Old name', ...older }, 409)
  await request('PUT', '/profile', { currency: 'PEN', ...older })
  assert.equal((await request('GET', '/profile')).name, 'Latest name')
  assert.equal((await request('GET', '/profile')).currency, 'PEN')
  ctx.check(
    'Catalog edits reject delayed saves atomically; independent profile fields do not conflict',
    true
  )

  const cash = randomUUID()
  await request('POST', '/accounts', { id: cash, name: 'Cash', openingBalance: 100 }, 201)
  await request(
    'POST',
    '/transactions',
    { accountId: main, categoryId: income.id, type: 'Income', amount: 200, date: day },
    201
  )
  await request(
    'POST',
    '/transactions',
    { accountId: cash, categoryId: expense.id, type: 'Expense', amount: 10, date: day },
    201
  )
  await request(
    'POST',
    '/transfers',
    { id: randomUUID(), sourceId: main, destinationId: cash, amount: 20, date: day, comment: '' },
    201
  )
  const scoped = await request('GET', `/analytics?accountId=${cash}&days=7`)
  assert.equal(scoped.insights.currentMonthExpense, 10)
  assert.equal(scoped.insights.currentMonthIncome, 0)
  assert.equal(scoped.trendData.at(-1).balance, 110)
  assert.equal(
    (await request('GET', `/analytics?accountId=${main}&days=7`)).trendData.at(-1).balance,
    180
  )
  assert.equal((await request('GET', '/analytics?days=7')).trendData.at(-1).balance, 290)
  const comparison = await request(
    'GET',
    `/analytics/category-comparison?accountId=${cash}&mode=day&anchor=${day}`
  )
  assert.equal(
    comparison.categoryComparison.reduce((sum, row) => sum + row.current, 0),
    10
  )
  assert.equal(
    (
      await request(
        'GET',
        `/analytics/category-comparison?accountId=${main}&mode=day&anchor=${day}`
      )
    ).categoryComparison.length,
    0
  )
  await request('GET', '/analytics?accountId=foreign', undefined, 404)
  await request('GET', '/analytics/category-comparison?accountId=foreign', undefined, 404)
  ctx.check(
    'Analytics account scopes isolate totals, comparison and transfer-aware historical balances',
    true
  )

  const csv = `Date;Type;Account;Category;Tags;Comment;Amount\n2020-01-01;Income;Main;${income.name};;Receipt check;1.00`
  const preview = await request('POST', '/transactions/import/preview', { csv })
  const importId = randomUUID()
  assert.equal((await request('GET', `/transactions/import/${importId}`)).state, 'unconfirmed')
  const body = { csv, importId, version: preview.version, selectedLines: [2] }
  const imported = await request('POST', '/transactions/import', body)
  const receipt = await request('GET', `/transactions/import/${importId}`)
  assert.equal(receipt.state, 'confirmed')
  assert.equal(receipt.result.imported, imported.imported)
  assert.deepEqual(await request('POST', '/transactions/import', body), imported)
  const token = ctx.state.token
  await createTestUser(ctx, 'second@example.com')
  assert.equal((await request('GET', `/transactions/import/${importId}`)).state, 'unconfirmed')
  ctx.state.token = token
  ctx.check(
    'Import receipts recover confirmed results without replaying writes and remain owner scoped',
    true
  )
})
