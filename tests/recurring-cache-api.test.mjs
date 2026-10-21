import assert from 'node:assert/strict'
import { withServer, createTestUser } from './helpers.mjs'
await withServer(
  'recurring-cache-api',
  async ctx => {
    const { expense } = await createTestUser(ctx)
    await ctx.call('GET', '/api/dashboard')
    const today = new Date().toISOString().slice(0, 10)
    const created = await ctx.call('POST', '/api/recurring', {
      amount: 17,
      type: 'EXPENSE',
      categoryId: expense.id,
      frequency: 'DAY',
      interval: 1,
      startDate: today
    })
    assert.equal(created.status, 201)
    assert.equal(created.headers.get('X-Porkex-Recurring-State'), 'ready')
    const rows = await ctx.call('GET', '/api/transactions')
    assert.equal(rows.data.items.filter(row => row.recurringId === created.data.id).length, 1)
    const updated = await ctx.call('PUT', `/api/recurring/${created.data.id}`, {
      amount: 19,
      type: 'EXPENSE',
      categoryId: expense.id,
      frequency: 'DAY',
      interval: 1,
      startDate: today,
      active: false
    })
    assert.equal(updated.status, 200)
    assert.equal((await ctx.call('DELETE', `/api/recurring/${created.data.id}`)).status, 200)
    assert.equal((await ctx.call('GET', '/api/recurring')).data.length, 0)
    console.log('PASS production recurrence cache: writes invalidate a primed ready result')
  },
  { RECURRING_CACHE_TTL_MS: '30000' }
)
