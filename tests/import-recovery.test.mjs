import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { withServer, createTestUser, BACKEND_DIR } from './helpers.mjs'

const header = 'Date;Type;Account;Category;Tags;Comment;Amount'

await withServer(
  'import-recovery',
  async ctx => {
    const { user, income, expense } = await createTestUser(ctx, 'unfunded@example.com')
    const request = async (method, path, body, expected = 200) => {
      const result = await ctx.call(method, '/api' + path, body)
      assert.equal(result.status, expected, JSON.stringify(result.data))
      return result.data
    }
    const preview = csv => request('POST', '/transactions/import/preview', { csv })
    const confirmation = (csv, result) => ({
      csv,
      version: result.version,
      selectedLines: result.rows.map(row => row.line),
      importId: randomUUID()
    })
    const funds = async id =>
      (await request('GET', '/accounts')).find(account => account.id === id).balance

    const debtCsv = [
      header,
      `2020-01-01;Expense;Debt Account;${expense.name};;First debt;100.00`,
      `2020-01-02;Expense;Debt Account;${expense.name};;Second debt;50.00`
    ].join('\n')
    await request('POST', '/transactions/import', confirmation(debtCsv, await preview(debtCsv)))
    const debt = (await request('GET', '/accounts')).find(
      account => account.name === 'Debt Account'
    )
    assert.equal(debt.balance, -150)
    const movement = {
      type: 'Income',
      categoryId: income.id,
      accountId: debt.id,
      date: '2020-01-03',
      amount: 20,
      comment: 'Partial payment'
    }
    const payment = await request('POST', '/transactions', movement, 201)
    assert.equal(await funds(debt.id), -130)
    await request('PUT', `/transactions/${payment.id}`, { ...movement, amount: 30 })
    assert.equal(await funds(debt.id), -120)
    await request('PUT', `/transactions/${payment.id}`, { ...movement, amount: 10 }, 409)
    await request(
      'POST',
      '/transactions',
      { ...movement, type: 'Expense', categoryId: expense.id, amount: 1 },
      409
    )
    const debtMovements = (await request('GET', `/transactions?accountId=${debt.id}`)).items
    const first = debtMovements.find(row => row.comment === 'First debt')
    const second = debtMovements.find(row => row.comment === 'Second debt')
    await request('PUT', `/transactions/${first.id}`, {
      ...first,
      comment: 'Renamed debt',
      tagIds: []
    })
    assert.equal(await funds(debt.id), -120)
    await request('DELETE', `/transactions/${second.id}`)
    assert.equal(await funds(debt.id), -70)
    await request('DELETE', `/transactions/${payment.id}`, undefined, 409)
    await request('PUT', `/accounts/${debt.id}`, { name: 'Debt Renamed' })
    assert.equal(await funds(debt.id), -70)
    ctx.check(
      'Imported debt allows partial income, improving edits, expense deletion and neutral edits; worsening writes roll back',
      true
    )

    await request('PUT', `/accounts/main-${user.id}`, { balance: 100 })
    const transfer = {
      id: randomUUID(),
      sourceId: `main-${user.id}`,
      destinationId: debt.id,
      amount: 10,
      date: '2020-01-04',
      comment: ''
    }
    await request('POST', '/transfers', transfer, 201)
    assert.equal(await funds(debt.id), -60)
    await request('PUT', `/transfers/${transfer.id}`, { ...transfer, amount: 20 })
    assert.equal(await funds(debt.id), -50)
    await request('DELETE', `/transfers/${transfer.id}`, undefined, 409)
    await request(
      'POST',
      '/transfers',
      {
        ...transfer,
        id: randomUUID(),
        sourceId: debt.id,
        destinationId: `main-${user.id}`,
        amount: 1
      },
      409
    )
    assert.equal(await funds(debt.id), -50)
    assert.equal(await funds(`main-${user.id}`), 80)
    ctx.check(
      'Incoming transfers can reduce debt; reversing them or transferring out cannot deepen it',
      true
    )

    const cash = randomUUID()
    await request('POST', '/accounts', { id: cash, name: 'Cash', openingBalance: 0 }, 201)
    for (const name of ['Cash', ' cash ', 'CASH', 'Main'])
      await request('POST', '/accounts', { id: randomUUID(), name, openingBalance: 0 }, 409)
    await request('PUT', `/accounts/${debt.id}`, { name: 'cash' }, 409)
    await request('PUT', `/accounts/${cash}`, { name: 'CASH' })
    await request('PUT', `/accounts/${cash}`, { archived: true })
    await request('POST', '/accounts', { id: randomUUID(), name: 'cash', openingBalance: 0 }, 409)
    await request(
      'POST',
      '/accounts',
      { id: randomUUID(), name: 'Cafe\u0301', openingBalance: 0 },
      201
    )
    await request('POST', '/accounts', { id: randomUUID(), name: 'Café', openingBalance: 0 }, 409)
    const goal = randomUUID()
    await request('POST', '/goals', { id: goal, name: 'Goal Account', targetAmount: 10 }, 201)
    await request(
      'POST',
      '/accounts',
      { id: randomUUID(), name: 'goal account', openingBalance: 0 },
      409
    )
    const concurrent = await Promise.all(
      [0, 1].map(() =>
        ctx.call('POST', '/api/accounts', {
          id: randomUUID(),
          name: 'Concurrent',
          openingBalance: 0
        })
      )
    )
    assert.deepEqual(concurrent.map(result => result.status).sort(), [201, 409])
    ctx.check(
      'Account names are unique across case, Unicode, archived accounts and goals, including concurrent writes',
      true
    )

    const count = 12001
    const accountName = 'A'.repeat(60)
    const categoryName = 'C'.repeat(60)
    const tagNames = Array.from({ length: 5 }, (_, index) => `Tag${index}${'x'.repeat(16)}`)
    const lines = Array.from({ length: count }, (_, index) =>
      [
        '2020-02-01',
        'Income',
        accountName,
        categoryName,
        tagNames.join(','),
        `Record ${index}`.padEnd(200, 'x'),
        '0.01'
      ].join(';')
    )
    const csv = [header, ...lines].join('\r\n')
    assert.ok(Buffer.byteLength(csv) > 5 * 1024 * 1024)
    const largePreview = await preview(csv)
    assert.equal(largePreview.rows.length, count)
    assert.ok(largePreview.rows.every(row => !row.errors.length && !row.duplicate.file))
    const body = confirmation(csv, largePreview)
    const result = await request('POST', '/transactions/import', body)
    assert.equal(result.imported, count)
    assert.equal(result.createdAccounts, 1)
    assert.equal(result.createdCategories, 1)
    assert.equal(result.createdTags, 5)
    assert.deepEqual(await request('POST', '/transactions/import', body), result)
    const importedAccount = (await request('GET', '/accounts')).find(
      account => account.name === accountName
    )
    assert.equal(importedAccount.balance, count / 100)
    const list = await request(
      'GET',
      `/transactions?accountId=${importedAccount.id}&sortBy=date&order=asc`
    )
    assert.equal(list.total, count)
    assert.ok(
      list.items.every(
        (row, index) => row.comment.startsWith(`Record ${index}x`) && row.tags.length === 5
      )
    )
    const exported = await fetch(
      ctx.base + '/api/transactions/export?accountId=' + importedAccount.id,
      { headers: { Authorization: `Bearer ${ctx.state.token}` } }
    )
    assert.equal(exported.status, 200)
    const restoredPreview = await preview(await exported.text())
    assert.equal(restoredPreview.rows.length, count)
    assert.ok(restoredPreview.rows.every(row => row.duplicate.existing && !row.errors.length))
    ctx.check(
      'A complete backup over 12,000 rows and 5 MB imports in batches, keeps tags/order/cents, replays safely and exports back into the importer',
      true
    )

    const rawSql = sql => {
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          "const {createClient}=require('@libsql/client');const db=createClient({url:process.argv[1]});db.execute(process.argv[2]).then(()=>db.close()).catch(e=>{console.error(e);process.exit(1)})",
          `file:${ctx.dbFile.replace(/\\/g, '/')}`,
          sql
        ],
        { cwd: BACKEND_DIR, encoding: 'utf8' }
      )
      assert.equal(child.status, 0, child.stderr)
    }
    rawSql(
      `CREATE TRIGGER fail_csv_batch BEFORE INSERT ON "Transaction" WHEN NEW.description = 'Reject batch' BEGIN SELECT RAISE(ABORT, 'forced batch failure'); END`
    )
    const failingCsv = [
      header,
      ...Array.from(
        { length: 301 },
        (_, index) =>
          `2020-03-01;Income;Rollback Account;Rollback Category;Rollback Tag;${index === 300 ? 'Reject batch' : 'Row ' + index};1.00`
      )
    ].join('\n')
    const failingBody = confirmation(failingCsv, await preview(failingCsv))
    const before = (await request('GET', '/transactions')).total
    await request('POST', '/transactions/import', failingBody, 500)
    assert.equal((await request('GET', '/transactions')).total, before)
    assert.ok(
      !(await request('GET', '/accounts')).some(account => account.name === 'Rollback Account')
    )
    assert.ok(
      !(await request('GET', '/categories')).some(category => category.name === 'Rollback Category')
    )
    assert.ok(!(await request('GET', '/tags')).some(tag => tag.name === 'Rollback Tag'))
    rawSql('DROP TRIGGER fail_csv_batch')
    assert.equal((await request('POST', '/transactions/import', failingBody)).imported, 301)
    ctx.check(
      'A later batch failure rolls back earlier batches and all catalogs; retrying the original import succeeds',
      true
    )

    await createTestUser(ctx, 'other-import-recovery@example.com')
    await request('POST', '/accounts', { id: randomUUID(), name: 'cash', openingBalance: 0 }, 201)
    assert.equal((await request('GET', '/transactions')).total, 0)
    ctx.check('Name uniqueness and imported histories stay scoped to their owner', true)
  },
  { PORKEX_TEST_COMPILED: 'true' }
)
