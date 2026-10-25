import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { withServer, createTestUser } from './helpers.mjs'
const day = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10)
await withServer('occurrences', async ctx => {
  const { expense, income } = await createTestUser(ctx)
  const request = async (method, path, body, status = 200) => {
    const r = await ctx.call(method, '/api' + path, body)
    assert.equal(r.status, status, JSON.stringify(r.data))
    return r.data
  }
  const create = () =>
    request(
      'POST',
      '/recurring',
      {
        type: 'Expense',
        amount: 10,
        categoryId: expense.id,
        frequency: 'DAY',
        interval: 1,
        startDate: day(1)
      },
      201
    )
  const rule = await create()
  const path = `/recurring/${rule.id}/occurrences/${day(1)}`
  await request('PUT', path, { kind: 'SKIP' })
  await request('PUT', path, { kind: 'SKIP' })
  assert.equal((await request('GET', '/recurring'))[0].nextDate.slice(0, 10), day(2))
  await request(
    'PUT',
    `/recurring/${rule.id}/occurrences/${day(1)}`,
    { kind: 'EDIT', amount: 10, categoryId: expense.id },
    409
  )
  const editRule = await create()
  const editPath = `/recurring/${editRule.id}/occurrences/${day(1)}`
  await request('PUT', editPath, { kind: 'EDIT', amount: 12, categoryId: expense.id })
  assert.equal(
    (await request('GET', '/recurring')).find(row => row.id === editRule.id).nextException.amount,
    12
  )
  await request('PUT', editPath, { kind: 'EDIT', amount: 10, categoryId: expense.id })
  assert.equal(
    (await request('GET', '/recurring')).find(row => row.id === editRule.id).nextException,
    null,
    'Restoring all original values clears the next-only notice'
  )
  await request('PUT', editPath, {
    kind: 'EDIT',
    amount: 10,
    categoryId: expense.id,
    comment: 'Different comment'
  })
  assert.equal(
    (await request('GET', '/recurring')).find(row => row.id === editRule.id).nextException.comment,
    'Different comment',
    'Same amount with a real change retains the notice'
  )
  await request('POST', '/tags', { id: 'occurrence-tag', name: 'Once' }, 201)
  const edit = {
    kind: 'EDIT',
    amount: 23.45,
    comment: '',
    categoryId: expense.id,
    tagIds: ['occurrence-tag']
  }
  await request('PUT', editPath, edit)
  await request('PUT', editPath, { ...edit, categoryId: income.id }, 400)
  const visible = (await request('GET', '/recurring')).find(row => row.id === editRule.id)
  assert.equal(visible.amount, 10)
  assert.equal(visible.nextException.amount, 23.45)
  assert.equal(visible.nextException.tags[0].name, 'Once')
  // A child invokes the real materializer against the temporary DB on tomorrow's
  // calendar. It closes native SQLite handles before the harness deletes files.
  const script = `require('ts-node/register/transpile-only'); const {runDueRules}=require('./src/lib/recurring'); runDueRules(${ctx.state.token ? 1 : 0},new Date('${day(1)}T12:00:00Z'),'UTC').then(()=>require('./src/lib/prisma').prisma.$disconnect()).catch(e=>{console.error(e);process.exitCode=1})`
  const child = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: `file:${ctx.dbFile.replace(/\\/g, '/')}`,
      TURSO_AUTH_TOKEN: '',
      JWT_SECRET: 'test-secret'
    }
  })
  assert.equal(child.status, 0, child.stderr)
  await request('PUT', editPath, edit) // lost response replay is acknowledged
  const rows = (await request('GET', '/transactions')).items
  const row = rows.find(item => item.recurringId === editRule.id)
  assert.equal(row.amount, 23.45)
  assert.equal(row.tags[0].name, 'Once')
  assert.equal(
    rows.some(item => item.recurringId === rule.id),
    false
  )
  await request('PUT', editPath, { ...edit, amount: 99 }, 409)
  await request('DELETE', `/transactions/${row.id}`)
  await request('PUT', editPath, edit)
  assert.equal((await request('GET', '/transactions')).items.length, 0)
  const rescheduled = await request(
    'POST',
    '/recurring',
    {
      type: 'Expense',
      amount: 10,
      categoryId: expense.id,
      frequency: 'DAY',
      interval: 1,
      startDate: day(5)
    },
    201
  )
  await request('PUT', `/recurring/${rescheduled.id}/occurrences/${day(5)}`, { kind: 'SKIP' })
  const resumed = await request('PUT', '/recurring/' + rescheduled.id, {
    type: 'Expense',
    amount: 10,
    categoryId: expense.id,
    frequency: 'DAY',
    interval: 1,
    startDate: day()
  })
  assert.equal(
    resumed.nextDate.slice(0, 10),
    day(1),
    'A future skip must not suppress unrelated earlier dates after a calendar edit'
  )
  const skippedAgain = await request('PUT', '/recurring/' + rescheduled.id, {
    type: 'Expense',
    amount: 10,
    categoryId: expense.id,
    frequency: 'DAY',
    interval: 1,
    startDate: day(5)
  })
  assert.equal(
    skippedAgain.nextDate.slice(0, 10),
    day(6),
    'The explicitly skipped date remains skipped after calendar edits'
  )
  console.log(
    'PASS occurrences: exact date, idempotent skip/edit, one-only materialization, tags and deleted history'
  )
})
