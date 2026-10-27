import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('full-backup', async ctx => {
  const { user, expense, income } = await createTestUser(ctx, 'backup@example.test')
  const main = `main-${user.id}`
  const request = async (method, path, body, expected = 200) => {
    const result = await ctx.call(method, '/api' + path, body)
    assert.equal(
      result.status,
      expected,
      JSON.stringify(result.data) + '\n' + ctx.logs.slice(-6).join('')
    )
    return result.data
  }
  await request('PUT', `/accounts/${main}`, { openingBalance: 500 })
  await request(
    'POST',
    '/accounts',
    { id: 'cash', name: 'Cash', openingBalance: 50, excludeFromTotalBalance: true },
    201
  )
  await request('POST', '/accounts', { id: 'archived', name: 'Archived', openingBalance: 0 }, 201)
  await request('PUT', '/accounts/archived', { archived: true })
  await request('POST', '/goals', { id: 'holiday', name: 'Holiday', targetAmount: 1000 }, 201)
  await request(
    'POST',
    '/transfers',
    {
      id: 'fund-goal',
      sourceId: main,
      destinationId: 'holiday',
      amount: 25,
      date: '2026-01-01',
      comment: ''
    },
    201
  )
  await request('POST', '/tags', { id: 'personal', name: 'Personal' }, 201)
  await request('POST', '/tags', { id: 'personal-alias', name: 'PERSONAL' }, 201)
  await request(
    'POST',
    '/transactions',
    {
      clientId: 'backup-expense',
      accountId: main,
      categoryId: expense.id,
      type: 'Expense',
      amount: 17.89,
      date: '2026-01-01',
      tagIds: ['personal'],
      comment: 'Lunch'
    },
    201
  )
  await request(
    'POST',
    '/budgets',
    {
      clientId: 'backup-budget',
      accountId: main,
      categoryId: expense.id,
      amount: 100,
      period: 'YEAR'
    },
    201
  )
  await request(
    'POST',
    '/favorites',
    {
      id: 'usual-lunch',
      name: 'Usual lunch',
      type: 'Expense',
      amount: 5,
      categoryId: expense.id,
      accountId: main,
      tagIds: ['personal'],
      comment: ''
    },
    201
  )
  const rule = await request(
    'POST',
    '/recurring',
    {
      clientId: 'backup-rule',
      accountId: main,
      categoryId: income.id,
      type: 'Income',
      amount: 100,
      description: 'Salary',
      tagIds: ['personal-alias'],
      frequency: 'MONTH',
      interval: 1,
      startDate: '2090-01-01'
    },
    201
  )
  await request('PUT', `/recurring/${rule.id}/occurrences/2090-01-01`, {
    kind: 'EDIT',
    amount: 125,
    comment: 'Bonus',
    categoryId: income.id,
    tagIds: ['personal']
  })
  await request('PUT', '/profile', {
    currency: 'PEN',
    defaultPeriod: 'month',
    firstDayOfWeek: 'SUNDAY',
    decimalSeparator: ','
  })
  const backup = await request('GET', '/backup')
  assert.equal(backup.tables.Transaction[0].amount, 1789)
  for (const table of Object.keys(backup.tables))
    assert.ok(backup.tables[table].length, `${table} must be covered`)
  assert.ok(!JSON.stringify(backup).includes('password'))
  assert.ok(!JSON.stringify(backup).includes('sessionVersion'))
  const originalBalances = await request('GET', '/accounts?includeGoals=true')
  assert.equal(backup.tables.Budget[0].period, 'YEAR')
  assert.equal(backup.tables.Account.find(row => row.name === 'Cash').excludeFromTotalBalance, true)
  const legacy = JSON.parse(JSON.stringify(backup))
  for (const row of legacy.tables.Account) delete row.excludeFromTotalBalance
  for (const row of legacy.tables.Category) delete row.position
  delete legacy.tables.RecurringTag
  await request('POST', '/backup/preview', { backup: legacy })
  for (const table of ['Account', 'Category', 'Tag', 'Favorite']) {
    const duplicate = JSON.parse(JSON.stringify(backup))
    const original = duplicate.tables[table][0]
    duplicate.tables[table].push({
      ...original,
      id: typeof original.id === 'number' ? 2147483647 : randomUUID(),
      name: ' ' + original.name.toUpperCase() + ' ',
      ...(table === 'Tag' ? { normalizedName: 'different-key' } : {})
    })
    await request('POST', '/backup/preview', { backup: duplicate }, 400)
  }
  const corrupt = JSON.parse(JSON.stringify(backup))
  corrupt.tables.Transaction[0].categoryId = 99999999
  await request('POST', '/backup/preview', { backup: corrupt }, 400)
  const preview = await request('POST', '/backup/preview', { backup })
  await request('POST', '/accounts', { id: 'later', name: 'Later', openingBalance: 0 }, 201)
  await request('POST', '/backup/restore', { backup, ...preview, importId: randomUUID() }, 409)
  const nextPreview = await request('POST', '/backup/preview', { backup })
  const executeSql = sql => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import {createClient} from '@libsql/client'; const db=createClient({url:'file:'+process.argv[1]}); await db.execute(process.argv[2]); db.close()",
        ctx.dbFile,
        sql
      ],
      { encoding: 'utf8' }
    )
    assert.equal(child.status, 0, child.stderr)
  }
  {
    executeSql(
      `CREATE TRIGGER backup_rollback BEFORE INSERT ON Favorite BEGIN SELECT RAISE(ABORT, 'test rollback'); END`
    )
    await request(
      'POST',
      '/backup/restore',
      { backup, ...nextPreview, importId: randomUUID() },
      500
    )
    assert.ok((await request('GET', '/accounts')).some(row => row.name === 'Later'))
    executeSql('DROP TRIGGER backup_rollback')
  }
  const importId = randomUUID()
  const oldToken = ctx.state.token
  const restored = await request('POST', '/backup/restore', { backup, ...nextPreview, importId })
  ctx.state.token = restored.token
  assert.equal(
    (await ctx.call('GET', '/api/accounts', undefined, { Authorization: `Bearer ${oldToken}` }))
      .status,
    401
  )
  const balances = await request('GET', '/accounts?includeGoals=true')
  assert.equal(balances.find(row => row.name === 'Cash').excludeFromTotalBalance, true)
  assert.deepEqual(
    balances.map(row => [row.name, row.balance, row.archived]).sort(),
    originalBalances.map(row => [row.name, row.balance, row.archived]).sort()
  )
  const after = await request('GET', '/backup')
  for (const table of Object.keys(backup.tables))
    assert.equal(after.tables[table].length, backup.tables[table].length, table)
  assert.equal(after.profile.currency, 'PEN')
  assert.equal(after.tables.RecurringRule[0].nextDate, backup.tables.RecurringRule[0].nextDate)
  assert.equal(after.tables.OccurrenceOverride[0].amount, 12500)
  assert.equal(after.tables.Favorite[0].tagIds, JSON.stringify([after.tables.Tag[0].id]))
  const replay = await request('POST', '/backup/restore', { backup, ...nextPreview, importId })
  assert.equal(replay.receiptId, restored.receiptId)
  assert.equal((await request('GET', `/backup/restores/${importId}`)).state, 'confirmed')
  await request(
    'POST',
    '/backup/restore',
    {
      backup: { ...backup, profile: { ...backup.profile, name: 'Changed' } },
      ...nextPreview,
      importId
    },
    400
  )
  const other = await createTestUser(ctx, 'other-backup@example.test')
  const otherPreview = await request('POST', '/backup/preview', { backup })
  const otherRestore = await request('POST', '/backup/restore', {
    backup,
    ...otherPreview,
    importId: randomUUID()
  })
  ctx.state.token = otherRestore.token
  assert.equal((await request('GET', '/profile')).email, other.user.email)
  assert.equal((await request('GET', `/backup/restores/${importId}`)).state, 'unconfirmed')
  const otherBackup = await request('GET', '/backup')
  assert.equal(otherBackup.tables.Transaction[0].amount, 1789)
  assert.notEqual(otherBackup.tables.Transaction[0].id, after.tables.Transaction[0].id)
  const untouched = await ctx.call('GET', '/api/backup', undefined, {
    Authorization: `Bearer ${replay.token}`
  })
  assert.equal(untouched.status, 200)
  assert.deepEqual(untouched.data.tables, after.tables)
  const large = JSON.parse(JSON.stringify(backup))
  large.tables.Transaction = Array.from({ length: 1000 }, (_, index) => ({
    ...backup.tables.Transaction[0],
    id: backup.tables.Transaction[0].id + index,
    clientId: `large-backup-${index}`,
    description: 'x'.repeat(200)
  }))
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 100 * 1024)
  const largePreview = await request('POST', '/backup/preview', { backup: large })
  const largeRestore = await request('POST', '/backup/restore', {
    backup: large,
    ...largePreview,
    importId: randomUUID()
  })
  ctx.state.token = largeRestore.token
  assert.equal((await request('GET', '/backup')).tables.Transaction.length, 1000)
})
