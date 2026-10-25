import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('catalog-names', async ctx => {
  const { user, expense } = await createTestUser(ctx)
  const cases = [
    ['/accounts', () => ({ id: randomUUID(), openingBalance: 0 })],
    ['/categories', () => ({ type: 'Expense' })],
    ['/tags', () => ({ id: randomUUID() })],
    ['/goals', () => ({ id: randomUUID(), targetAmount: 100 })],
    [
      '/favorites',
      () => ({
        id: randomUUID(),
        accountId: `main-${user.id}`,
        categoryId: expense.id,
        type: 'Expense',
        amount: 1,
        tagIds: []
      })
    ]
  ]
  for (const [path, payload] of cases) {
    for (const name of ['Bad.Name', 'Bad,Name', 'Bad_name', 'Bad/name', 'Bad\nName', '💰']) {
      const response = await ctx.call('POST', '/api' + path, { ...payload(), name })
      assert.equal(response.status, 400, `${path} ${name}: ${JSON.stringify(response.data)}`)
    }
    const name = ` Café niño-${path.slice(1)} 123 `
    const response = await ctx.call('POST', '/api' + path, { ...payload(), name })
    // Tags have a shorter limit; use a short accent-bearing name instead.
    if (path === '/tags') {
      const tag = await ctx.call('POST', '/api/tags', {
        id: randomUUID(),
        name: ' Cafe\u0301 ñ-123 '
      })
      assert.equal(tag.status, 201)
      assert.equal(tag.data.name, 'Café ñ-123')
    } else {
      assert.equal(response.status, 201, JSON.stringify(response.data))
      assert.equal(response.data.name, name.trim())
    }
  }
  ctx.check(
    'Accounts, categories, tags, goals and favorites enforce the same normalized name alphabet',
    true
  )
})
