import { withServer, createTestUser } from './helpers.mjs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

await withServer('reliability', async ctx => {
  const { call, check, base, state, dbFile } = ctx
  const { expense } = await createTestUser(ctx)
  const day = new Date().toISOString().slice(0, 10)
  const tx = {
    amount: 1,
    type: 'Expense',
    description: 'Validation',
    categoryId: expense.id,
    date: day
  }
  for (const amount of [true, [1], {}, 1.234]) {
    check(
      `invalid amount ${JSON.stringify(amount)} rejected`,
      (await call('POST', '/api/transactions', { ...tx, amount })).status === 400
    )
  }
  for (const date of ['2026-02-31', '2026-02-31T00:00:00Z']) {
    check(
      `invalid date ${date} rejected`,
      (await call('POST', '/api/transactions', { ...tx, date })).status === 400
    )
  }
  check(
    'invalid filter date rejected',
    (await call('GET', '/api/transactions?from=2026-02-31')).status === 400
  )
  check(
    'invalid timezone rejected',
    (await call('GET', '/api/recurring', undefined, { 'X-Porkex-Time-Zone': 'Unknown/City' }))
      .status === 400
  )
  const fallback = await fetch(`${base}/api/recurring`, {
    headers: { Authorization: `Bearer ${state.token}` }
  })
  check(
    'older client without timezone uses Lima',
    fallback.status === 200 && fallback.headers.get('X-Porkex-Recurring-State') === 'ready'
  )
  const category = (await call('POST', '/api/categories', { name: 'Future rule', type: 'Expense' }))
    .data
  const rule = (
    await call('POST', '/api/recurring', {
      amount: 1,
      type: 'Expense',
      description: 'Future',
      categoryId: category.id,
      frequency: 'DAY',
      interval: 1,
      startDate: '2090-01-01'
    })
  ).data
  check(
    'category type cannot contradict future recurring rule',
    (await call('PUT', `/api/categories/${category.id}`, { name: category.name, type: 'Income' }))
      .status === 409
  )
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [resolve('tests/db-cli.mjs'), ...args], {
      encoding: 'utf8'
    })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  const url = `file:${dbFile.replace(/\\/g, '/')}`
  const past = new Date(new Date(`${day}T00:00:00Z`).getTime() - 250 * 86400000)
    .toISOString()
    .slice(0, 10)
  cli('age', url, String(rule.id), past)
  const response = await call('GET', '/api/recurring')
  check(
    'bounded catch-up reports pending',
    response.headers.get('X-Porkex-Recurring-State') === 'pending'
  )
  await Promise.all([call('GET', '/api/recurring'), call('GET', '/api/recurring')])
  const finished = await call('GET', '/api/recurring')
  check(
    'subsequent catch-up reaches ready',
    finished.headers.get('X-Porkex-Recurring-State') === 'ready'
  )
  cli('age', url, String(rule.id), day)
  cli('frequency', url, String(rule.id), 'INVALID')
  const failed = await call('GET', '/api/recurring')
  check(
    'failed catch-up remains visible without making reads unavailable',
    failed.status === 200 && failed.headers.get('X-Porkex-Recurring-State') === 'failed'
  )
  cli('frequency', url, String(rule.id), 'DAY')
  check(
    'failed catch-up is retried on the next request',
    (await call('GET', '/api/recurring')).headers.get('X-Porkex-Recurring-State') === 'ready'
  )
  const clock = spawnSync(process.execPath, [resolve('tests/recurring-clock-worker.mjs'), url], {
    encoding: 'utf8'
  })
  check(
    'real materialization observes Lima/DST midnight and rolls back failed batches',
    clock.status === 0,
    clock.stderr
  )
})
