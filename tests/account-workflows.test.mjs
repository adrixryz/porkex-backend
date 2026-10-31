import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('account-workflows', async ctx => {
  const { user, income, expense } = await createTestUser(ctx, 'unfunded@example.com')
  const main = `main-${user.id}`
  const cash = randomUUID()
  const call = async (method, path, body, status = 200) => {
    const result = await ctx.call(method, '/api' + path, body)
    assert.equal(result.status, status, JSON.stringify(result.data))
    return result.data
  }
  await call('PUT', `/accounts/${main}`, { balance: 500, mutationId: randomUUID() })
  await call('POST', '/accounts', { id: cash, name: 'Cash', openingBalance: 100 }, 201)
  const date = new Date().toISOString().slice(0, 10)
  const previous = new Date(date + 'T00:00:00Z')
  previous.setUTCDate(previous.getUTCDate() - 1)
  const yesterday = previous.toISOString().slice(0, 10)
  for (let index = 0; index < 9; index++) {
    await call(
      'POST',
      '/transactions',
      {
        clientId: randomUUID(),
        accountId: main,
        type: 'Income',
        categoryId: income.id,
        amount: 1,
        date,
        comment: `Income ${index}`
      },
      201
    )
  }
  const recent = await call(
    'POST',
    '/transactions',
    {
      clientId: randomUUID(),
      accountId: cash,
      type: 'Expense',
      categoryId: expense.id,
      amount: 10,
      date: yesterday,
      comment: 'Backdated cash expense'
    },
    201
  )
  const total = await call('GET', `/dashboard?from=${yesterday}&to=${date}`)
  assert.equal(total.recentTransactions.length, 8)
  assert.ok(total.recentTransactions.every(item => item.date.slice(0, 10) === date))
  assert.ok(!total.recentTransactions.some(item => item.id === recent.id))
  assert.equal(total.totalIncome, 9)
  assert.equal(total.totalExpense, 10)
  assert.equal(total.globalBalance, 599)
  assert.equal(total.incomePieChartData[0].value, 9)
  const scoped = await call('GET', `/dashboard?accountId=${cash}&from=${yesterday}&to=${date}`)
  assert.equal(scoped.globalBalance, 90)
  assert.equal(scoped.transactionCount, 1)
  assert.equal(scoped.totalIncome, 0)
  const today = await call('GET', `/dashboard?accountId=${cash}&from=${date}&to=${date}`)
  assert.equal(today.transactionCount, 0)
  assert.equal(today.globalBalance, 90, 'Period navigation must not change the actual balance')
  assert.deepEqual(today.pieChartData, [])
  await call('GET', '/dashboard?accountId=foreign', undefined, 404)
  ctx.check(
    'Dashboard scopes period data, includes Cash in Total and sorts its latest movements by effective date',
    true
  )

  const budget = { categoryId: expense.id, amount: 50, period: 'MONTH' }
  const mainBudget = await call('POST', '/budgets', { ...budget, accountId: main }, 201)
  const cashBudget = await call('POST', '/budgets', { ...budget, accountId: cash }, 201)
  await call('POST', '/budgets', { ...budget, accountId: cash }, 409)
  const all = await call('GET', `/budgets?today=${date}`)
  assert.equal(all.budgets.find(row => row.id === mainBudget.id).spent, 0)
  // Yesterday can belong to the previous month; anchor progress to that date.
  const cashProgress = await call('GET', `/budgets?accountId=${cash}&today=${yesterday}`)
  assert.deepEqual(
    cashProgress.budgets.map(row => row.id),
    [cashBudget.id]
  )
  assert.equal(cashProgress.budgets[0].spent, 10)
  await call('PUT', `/budgets/${cashBudget.id}`, { ...budget, accountId: main }, 409)
  await call('POST', '/budgets', { ...budget, accountId: 'foreign' }, 400)
  await call('GET', '/budgets?accountId=foreign', undefined, 404)
  ctx.check('Budgets isolate spending and uniqueness by account and reject foreign accounts', true)

  const mutationId = randomUUID()
  const correction = { balance: 25, mutationId }
  await call('PUT', `/accounts/${cash}`, correction)
  await call('PUT', `/accounts/${cash}`, correction)
  assert.equal((await call('GET', '/accounts')).find(row => row.id === cash).balance, 25)
  const history = await call('GET', `/accounts/balance-adjustments?accountId=${cash}`)
  assert.equal(history.items.length, 2)
  assert.equal(history.items.find(row => row.kind === 'opening-balance').balance, 100)
  assert.equal(history.items[0].previousBalance, 90)
  assert.equal(history.items[0].balance, 25)
  assert.equal(history.items[0].id, `account:edit:${mutationId}`)
  await call('PUT', `/accounts/${cash}`, { name: 'Cash renamed', mutationId: randomUUID() })
  assert.equal(
    (await call('GET', `/accounts/balance-adjustments?accountId=${cash}`)).items.length,
    2
  )
  await call('PUT', `/accounts/${cash}`, { balance: -1 }, 400)
  ctx.check('Balance corrections preserve before/after history and deduplicate retries', true)

  const firstId = 'zz-' + randomUUID()
  const lastId = 'aa-' + randomUUID()
  const transfer = { sourceId: main, destinationId: cash, amount: 1, date, comment: '' }
  await call('POST', '/transfers', { ...transfer, id: firstId }, 201)
  await new Promise(resolve => setTimeout(resolve, 10))
  await call('POST', '/transfers', { ...transfer, id: lastId }, 201)
  assert.deepEqual(
    (await call('GET', '/transfers')).items.map(row => row.id),
    [lastId, firstId]
  )
  const timeline = await call('GET', `/accounts/movements?accountId=${cash}`)
  assert.deepEqual(
    timeline.items.slice(0, 2).map(row => row.id),
    [lastId, firstId]
  )
  assert.equal(timeline.items.at(-1).kind, 'opening-balance')
  assert.equal(timeline.items.at(-1).balance, 100)
  assert(
    timeline.items.every(
      (row, index, rows) =>
        index === 0 ||
        rows[index - 1].date >= row.date ||
        (rows[index - 1].date.slice(0, 10) === row.date.slice(0, 10) &&
          rows[index - 1].createdAt >= row.createdAt)
    )
  )
  assert.equal((await call('GET', '/accounts/movements?accountId=foreign')).total, 0)
  await call('PUT', `/accounts/${cash}`, { archived: true, mutationId: randomUUID() }, 409)
  await call('PUT', `/accounts/${cash}`, { balance: 0, mutationId: randomUUID() })
  await call('PUT', `/accounts/${cash}`, { archived: true, mutationId: randomUUID() })
  await call('POST', '/transfers', { ...transfer, id: randomUUID() }, 400)
  await call('PUT', `/accounts/${cash}`, { archived: false, mutationId: randomUUID() })
  assert.equal((await call('GET', '/accounts')).find(row => row.id === cash).archived, false)
  assert.equal((await call('GET', '/transfers')).items.length, 2)
  ctx.check(
    'Transfers sort by creation time within a date; archive and restore preserve history',
    true
  )
  const vacation = randomUUID()
  const savings = randomUUID()
  const consoleGoal = randomUUID()
  await call('POST', '/goals', { id: vacation, name: 'Vacation', targetAmount: 800 }, 201)
  await call('POST', '/accounts', { id: savings, name: 'Savings', openingBalance: 0 }, 201)
  await call('POST', '/goals', { id: consoleGoal, name: 'PS5', targetAmount: 999 }, 201)
  assert.deepEqual(
    (await call('GET', '/accounts?includeGoals=true')).map(row => row.id),
    [main, cash, savings, vacation, consoleGoal]
  )
  ctx.check('Account selectors list normal accounts before goals in creation order', true)
  const empty = randomUUID()
  await call('POST', '/accounts', { id: empty, name: 'Unused', openingBalance: 0 }, 201)
  await call('DELETE', `/accounts/${empty}`, undefined, 409)
  await call('PUT', `/accounts/${empty}`, { archived: true, mutationId: randomUUID() })
  await call('DELETE', `/accounts/${empty}`)
  await call('DELETE', `/accounts/${empty}`)
  assert.equal(
    (await call('GET', '/accounts')).some(row => row.id === empty),
    false
  )
  await call('PUT', `/accounts/${cash}`, { archived: true, mutationId: randomUUID() })
  await call('DELETE', `/accounts/${cash}`, undefined, 409)
  await call('DELETE', `/accounts/${main}`, undefined, 400)
  await call('DELETE', '/accounts/foreign', undefined, 404)
  ctx.check(
    'Only empty archived accounts can be deleted, with replay protection and ownership checks',
    true
  )
})
