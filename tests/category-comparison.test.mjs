import assert from 'node:assert/strict'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('category-comparison', async ctx => {
  const { categories, income } = await createTestUser(ctx)
  const byName = Object.fromEntries(categories.map(category => [category.name, category]))
  for (const [day, amount, category] of [
    ['2024-03-04', 0.1, byName.Food],
    ['2024-03-06', 0.2, byName.Food],
    ['2024-02-26', 0.2, byName.Food],
    ['2024-02-28', 10, byName.Transport],
    ['2024-02-29', 100, byName.Food],
    ['2023-03-06', 0.5, byName.Food],
    ['2023-03-07', 200, byName.Food],
    ['2023-01-01', 7, byName.Housing],
    ['2024-03-05', 10, byName.Entertainment],
    ['2024-03-06', 1000, income]
  ]) {
    const response = await ctx.call('POST', '/api/transactions', {
      date: day,
      amount,
      categoryId: category.id,
      type: category.type
    })
    assert.equal(response.status, 201)
  }
  const load = async mode => {
    const response = await ctx.call(
      'GET',
      `/api/analytics/category-comparison?mode=${mode}&today=2024-03-06`
    )
    assert.equal(response.status, 200)
    return response.data
  }
  const week = await load('week')
  const food = week.categoryComparison.find(row => row.name === 'Food')
  assert.deepEqual(food, {
    name: 'Food',
    color: byName.Food.color,
    current: 0.3,
    previous: 0.2,
    changePercent: 50
  })
  assert.equal(week.categoryComparison.find(row => row.name === 'Transport').changePercent, -100)
  assert.equal(
    week.categoryComparison.find(row => row.name === 'Entertainment').changePercent,
    null
  )
  assert.equal(
    week.categoryComparison.some(row => row.name === income.name),
    false
  )
  assert.equal(week.ranges.previous.to, '2024-02-28')
  const month = await load('month')
  assert.equal(month.categoryComparison.find(row => row.name === 'Food').previous, 100.2)
  assert.equal(month.ranges.previous.to, '2024-02-29')
  const year = await load('year')
  assert.equal(year.categoryComparison.find(row => row.name === 'Food').current, 100.5)
  assert.equal(year.categoryComparison.find(row => row.name === 'Food').previous, 0.5)
  assert.equal(year.categoryComparison.find(row => row.name === 'Housing').changePercent, -100)
  assert.equal(year.ranges.previous.to, '2023-03-06')
  const sunday = await ctx.call(
    'GET',
    '/api/analytics/category-comparison?mode=week&today=2024-03-06&weekStart=SUNDAY'
  )
  assert.equal(sunday.data.ranges.current.from, '2024-03-03')
  for (const [name, amount] of [
    ['Utilities', 3],
    ['Travel', 5],
    ['Health', 7]
  ]) {
    const category = await ctx.call('POST', '/api/categories', {
      name,
      type: 'EXPENSE',
      color: '#123456'
    })
    assert.equal(category.status, 201)
    assert.equal(
      (
        await ctx.call('POST', '/api/transactions', {
          date: '2024-03-01',
          amount,
          type: 'EXPENSE',
          categoryId: category.data.id
        })
      ).status,
      201
    )
  }
  const analytics = await ctx.call('GET', '/api/analytics?months=3&today=2024-03-06')
  const spending = analytics.data.topCategories
  assert.equal(spending.length, 5)
  assert.deepEqual(
    spending.map(row => row.name),
    ['Entertainment', 'Health', 'Travel', 'Utilities', 'Food']
  )
  assert.equal(Math.round(spending.reduce((sum, row) => sum + row.value, 0) * 100), 2530)
  assert.ok(spending.every(row => row.value > 0 && Number.isFinite(row.percent)))
  for (const query of ['mode=day', 'today=2024-02-30', 'weekStart=UNKNOWN'])
    assert.equal((await ctx.call('GET', '/api/analytics/category-comparison?' + query)).status, 400)
  await createTestUser(ctx, 'category-comparison-other@example.com')
  assert.deepEqual((await load('year')).categoryComparison, [])
  console.log(
    'PASS category comparison: month/week/year, partial ranges, cents, absent categories, zero bases and account isolation'
  )
})
