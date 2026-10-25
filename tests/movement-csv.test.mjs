import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withServer, createTestUser } from './helpers.mjs'

const header = 'Date;Type;Account;Category;Tags;Comment;Amount'
await withServer('movement-csv', async ctx => {
  const { user, income, expense } = await createTestUser(ctx, 'unfunded@example.com')
  const request = async (path, body, status = 200) => {
    const result = await ctx.call('POST', '/api/transactions/import' + path, body)
    assert.equal(result.status, status, JSON.stringify(result.data))
    return result.data
  }
  const snapshot = csv => request('/preview', { csv })
  const confirmation = (csv, preview, extra = {}) => ({
    csv,
    version: preview.version,
    selectedLines: preview.rows
      .filter(row => !row.duplicate.file && !row.duplicate.existing)
      .map(row => row.line),
    importId: randomUUID(),
    ...extra
  })
  const csv =
    '\uFEFF' +
    [
      header,
      '2020-01-02;Expense;Efectivo;Café;"Diario,Esencial";"Coffee; with ""milk""\nsecond line";4.75',
      `2020-01-01;Income;Main;${income.name};;;100.00`,
      '2020-01-02;Expense;Efectivo;Café;"Esencial,Diario";"Coffee; with ""milk""\nsecond line";4.75',
      `2020-01-02;Expense;Main;${expense.name};;Later;2.25`
    ].join('\r\n')
  const preview = await snapshot(csv)
  const trailingSlashPreview = await request('/preview/', {
    csv: csv + '\n'.repeat(60_000)
  })
  assert.deepEqual(
    trailingSlashPreview,
    preview,
    'A trailing slash keeps the CSV body limit policy'
  )
  assert.equal(preview.rows.length, 4)
  assert.deepEqual(
    preview.rows.map(row => row.line),
    [2, 4, 5, 7]
  )
  assert(preview.rows.every(row => !row.errors.length))
  assert.equal(preview.rows[2].duplicate.file, true)
  assert.equal(
    (await ctx.call('GET', '/api/transactions')).data.total,
    0,
    'Preview creates nothing'
  )
  const body = confirmation(csv, preview)
  const result = await request('', body)
  assert.deepEqual(
    [result.imported, result.createdAccounts, result.createdCategories, result.createdTags],
    [3, 1, 1, 2]
  )
  assert.deepEqual(await request('', body), result, 'Exact confirmation replays once')
  await request('', { ...body, selectedLines: [4] }, 409)
  const repeated = await snapshot(csv)
  assert(repeated.rows.every(row => row.duplicate.existing))
  const all = (await ctx.call('GET', '/api/transactions?order=asc&perPage=100')).data
  assert.deepEqual(
    all.items.map(row => row.amount),
    [100, 4.75, 2.25]
  )
  assert.equal(all.earliestDate, '2020-01-01')
  const categories = (await ctx.call('GET', '/api/categories')).data
  const coffee = categories.find(row => row.name === 'Café')
  assert.equal(coffee.color, '#9E9E9E')
  const accounts = (await ctx.call('GET', '/api/accounts')).data
  assert.equal(accounts.find(row => row.name === 'Efectivo').openingBalance, 0)
  const exportCsv = async query => {
    const response = await fetch(ctx.base + '/api/transactions/export?' + query, {
      headers: { Authorization: `Bearer ${ctx.state.token}` }
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition'), /backup/)
    return response.text()
  }
  const exported = await snapshot(await exportCsv('type=ALL&page=99&perPage=1&order=desc'))
  assert.deepEqual(
    exported.rows.map(row => row.amount),
    [100, 4.75, 2.25]
  )
  assert(exported.rows.every(row => row.duplicate.existing))
  for (const query of [
    'from=2020-01-02&to=2020-01-02&type=Expense',
    'categoryId=' + coffee.id,
    'accountId=main-' + user.id + '&search=Later&min=2&max=3',
    'tagId=' + (await ctx.call('GET', '/api/tags')).data[0].id
  ]) {
    const listed = (await ctx.call('GET', '/api/transactions?' + query)).data
    const exported = await snapshot(await exportCsv(query))
    assert.equal(exported.rows.length, listed.total, query)
    assert.deepEqual(
      exported.rows.map(row => row.amount).sort(),
      listed.items.map(row => row.amount).sort()
    )
  }
  ctx.check(
    'CSV quoting, file order, preview isolation, duplicate selection, replay and all export filters',
    true
  )

  for (const cells of [
    ['2020-02-30', 'Expense', 'Main', expense.name, '', '', '1'],
    ['2999-01-01', 'Expense', 'Main', expense.name, '', '', '1'],
    ['2020-01-01', 'Transfer', 'Main', expense.name, '', '', '1'],
    ['2020-01-01', 'Income', 'Main', expense.name, '', '', '1'],
    ['2020-01-01', 'Expense', 'Bad.Name', expense.name, '', '', '1'],
    ['2020-01-01', 'Expense', 'Main', 'Bad,Name', '', '', '1'],
    ['2020-01-01', 'Expense', 'Main', expense.name, 'A,A', '', '1'],
    ['2020-01-01', 'Expense', 'Main', expense.name, 'A,B,C,D,E,F', '', '1'],
    ['2020-01-01', 'Expense', 'Main', expense.name, '', 'x'.repeat(201), '1'],
    ...['0', '-1', '1.001', '1,50', '1e2', '10000000.01'].map(amount => [
      '2020-01-01',
      'Expense',
      'Main',
      expense.name,
      '',
      '',
      amount
    ])
  ]) {
    const invalid = header + '\n' + cells.join(';')
    const preview = await snapshot(invalid)
    assert(preview.rows[0].errors.length, JSON.stringify(cells))
    await request('', confirmation(invalid, preview), 400)
  }
  for (const invalid of [
    '',
    header,
    header.replaceAll(';', ','),
    header + '\n"unterminated',
    header + '\n"a"bad;b;c;d;e;f;g'
  ])
    await request('/preview', { csv: invalid }, 400)
  const conflict = [
    header,
    '2020-01-01;Income;Main;Shared;;;1',
    '2020-01-01;Expense;Main;Shared;;;1'
  ].join('\n')
  assert((await snapshot(conflict)).rows.every(row => row.errors.length))
  const staleCsv = `${header}\n2020-01-03;Income;Main;${income.name};;;1`
  const stale = await snapshot(staleCsv)
  await ctx.call('POST', '/api/categories', { name: 'Changed catalog', type: 'Expense' })
  await request('', confirmation(staleCsv, stale), 409)
  const updated = await snapshot(staleCsv)
  await request('', confirmation(staleCsv, updated, { selectedLines: [999] }), 400)
  await request('', confirmation(staleCsv, updated, { selectedLines: [2, 2] }), 400)
  ctx.check(
    'Invalid rows, malformed CSV, cross-type categories, stale preview and invalid selection fail atomically',
    true
  )
  const cash = (await ctx.call('GET', '/api/accounts')).data.find(row => row.name === 'Efectivo')
  assert.equal((await ctx.call('PUT', `/api/accounts/${cash.id}`, { balance: 0 })).status, 200)
  assert.equal((await ctx.call('PUT', `/api/accounts/${cash.id}`, { archived: true })).status, 200)
  const archivedBackup = await snapshot(await exportCsv('type=ALL'))
  const archivedRows = archivedBackup.rows.filter(row => row.account === 'Efectivo')
  assert(archivedRows.length > 0)
  assert(archivedRows.every(row => row.duplicate.existing && !row.importable && !row.errors.length))
  const archivedCsv = [header, '2020-01-02;Expense;Efectivo;Café;;;1.00'].join('\n')
  const archivedPreview = await snapshot(archivedCsv)
  assert(archivedPreview.rows[0].errors.some(error => error.includes('Restore')))
  await request('', confirmation(archivedCsv, archivedPreview), 400)
  await request(
    '',
    confirmation(await exportCsv('type=ALL'), archivedBackup, {
      selectedLines: [archivedRows[0].line]
    }),
    400
  )
  ctx.check(
    'Archived backup duplicates remain valid preview rows but cannot create archived movements',
    true
  )

  const duplicateCategory = await ctx.call('POST', '/api/categories', {
    name: ' CAFE\u0301 ',
    type: 'Income'
  })
  assert.equal(duplicateCategory.status, 409)
  const renameDuplicate = await ctx.call('PUT', `/api/categories/${income.id}`, {
    name: 'café',
    type: 'Income'
  })
  assert.equal(renameDuplicate.status, 409)
  ctx.check('Category creation and rename reject canonical duplicate names across types', true)

  await createTestUser(ctx, 'csv-other@example.com')
  assert.equal((await snapshot(staleCsv)).rows[0].duplicate.existing, false)
  const privateExport = await exportCsv('type=ALL')
  assert(!privateExport.includes('Coffee'))
  ctx.check('CSV preview and export remain user scoped', true)
})
