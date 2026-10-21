import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { withServer, createTestUser } from './helpers.mjs'
const require = createRequire(import.meta.url)
require('ts-node/register/transpile-only')
const { comparisonRanges, compareMovements } = require('../src/lib/comparison.ts')
const date = value => new Date(value + 'T00:00:00Z')
const leap = comparisonRanges('year', date('2024-01-01'), date('2024-02-29'), 1)
assert.equal(leap.previousEnd.toISOString().slice(0, 10), '2024-01-01')
assert.equal(leap.currentEnd.toISOString().slice(0, 10), '2024-03-01')
const week = comparisonRanges('week', date('2024-01-01'), date('2024-01-03'), 1)
assert.equal(week.previousStart.toISOString().slice(0, 10), '2023-12-25')
assert.equal(week.previousEnd.toISOString().slice(0, 10), '2024-01-01')
assert.equal(
  comparisonRanges('week', date('2024-01-03'), date('2024-01-03'), 0)
    .currentStart.toISOString()
    .slice(0, 10),
  '2023-12-31'
)
assert.equal(comparisonRanges('year', date('2090-01-01'), date('2024-01-03'), 1), null)
const compared = compareMovements('year', leap, [
  { amount: 1000, type: 'INCOME', date: date('2024-02-29') }
])
assert.equal(compared.delta.income.percent, null)
assert.equal(compared.delta.expense.percent, 0)
assert.equal(compared.buckets[2].included, false)
await withServer('comparison', async ctx => {
  const { expense, income } = await createTestUser(ctx)
  for (const [day, amount, category, type] of [
    ['2023-02-28', 10, expense.id, 'EXPENSE'],
    ['2023-03-01', 900, expense.id, 'EXPENSE'],
    ['2024-02-29', 25, income.id, 'INCOME']
  ]) {
    const result = await ctx.call('POST', '/api/transactions', {
      date: day,
      amount,
      categoryId: category,
      type
    })
    assert.equal(result.status, 201)
  }
  const result = await ctx.call(
    'GET',
    '/api/analytics/comparison?mode=year&anchor=2024-01-01&today=2024-02-29'
  )
  assert.equal(result.status, 200)
  assert.equal(result.data.current.income, 25)
  assert.equal(result.data.previous.expense, 910)
  assert.equal(result.data.ranges.previous.to, '2023-12-31')
  assert.equal(result.data.buckets[2].previous.expense, 900)
  assert.equal(result.data.buckets[2].included, false)
  assert.equal(
    (await ctx.call('GET', '/api/analytics/comparison?mode=week&anchor=2090-01-01')).status,
    400
  )
  await createTestUser(ctx, 'comparison-other@example.com')
  assert.equal(
    (await ctx.call('GET', '/api/analytics/comparison?mode=year&anchor=2024-01-01')).data.current
      .count,
    0
  )
  console.log(
    'PASS comparisons: full previous periods, leap day, year boundary, week preference, zero bases and ownership'
  )
})
