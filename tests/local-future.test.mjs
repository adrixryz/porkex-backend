import assert from 'node:assert/strict'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('local-future', async ctx => {
  const { expense } = await createTestUser(ctx)
  for (const zone of ['America/Lima', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date())
    const part = kind => parts.find(item => item.type === kind).value
    const day = `${part('year')}-${part('month')}-${part('day')}`
    const tomorrow = new Date(`${day}T00:00:00Z`)
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    const payload = { amount: 77, type: 'Expense', categoryId: expense.id, date: day }
    const headers = { 'X-Porkex-Time-Zone': zone }
    const created = await ctx.call('POST', '/api/transactions', payload, headers)
    assert.equal(created.status, 201)
    const future = { ...payload, date: tomorrow.toISOString().slice(0, 10) }
    assert.equal((await ctx.call('POST', '/api/transactions', future, headers)).status, 400)
    assert.equal(
      (await ctx.call('PUT', `/api/transactions/${created.data.id}`, future, headers)).status,
      400
    )
  }
})
