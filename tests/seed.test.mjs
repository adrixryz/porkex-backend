import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { withServer, createTestUser } from './helpers.mjs'

const require = createRequire(import.meta.url)
const { calendarToday, nextAfterToday } = require('../scripts/seed.js')
const isoDay = date => date.toISOString().slice(0, 10)
assert.equal(isoDay(calendarToday('America/Lima', new Date('2026-01-01T04:59:59Z'))), '2025-12-31')
assert.equal(isoDay(calendarToday('America/Lima', new Date('2026-01-01T05:00:00Z'))), '2026-01-01')
assert.equal(
  isoDay(calendarToday('America/New_York', new Date('2026-03-08T07:00:00Z'))),
  '2026-03-08'
)
assert.equal(
  isoDay(nextAfterToday(new Date('2024-01-31T00:00:00Z'), new Date('2024-02-29T00:00:00Z'))),
  '2024-03-31'
)

await withServer('seed', async ctx => {
  const { user: keeper, expense } = await createTestUser(ctx, 'keep-seed-test@example.com')
  await ctx.call('POST', '/api/tags', { id: 'keeper-tag', name: 'Keep' })
  await ctx.call('POST', '/api/transactions', {
    amount: 12.34,
    type: 'EXPENSE',
    categoryId: expense.id,
    tagIds: ['keeper-tag']
  })
  const env = {
    ...process.env,
    DATABASE_URL: `file:${ctx.dbFile.replace(/\\/g, '/')}`,
    TURSO_AUTH_TOKEN: '',
    SEED_EMAIL: 'seed-regression@example.com',
    SEED_PASSWORD: 'test-seed-password',
    SEED_NAME: 'Seed Regression',
    SEED_CURRENCY: 'USD',
    SEED_TIME_ZONE: 'America/Lima',
    // A different host zone must not shift generated calendar dates.
    TZ: 'Pacific/Kiritimati'
  }
  // The default must be exercised even if the caller configured a shorter seed.
  env.SEED_MONTHS = ''
  const seed = (reset = false, overrides = {}, expected = 0) => {
    const child = spawnSync(process.execPath, ['scripts/seed.js', ...(reset ? ['--reset'] : [])], {
      env: { ...env, ...overrides },
      encoding: 'utf8'
    })
    assert.equal(child.status, expected, child.stdout + child.stderr)
    return child.stdout
  }
  // Native database handles live in children, so Windows can delete the file.
  const inspect = async body => {
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const {PrismaClient}=require('@prisma/client');
      const {PrismaLibSQL}=require('@prisma/adapter-libsql');
      const {createClient}=require('@libsql/client');
      const {createHash}=require('node:crypto');
      const client=createClient({url:process.env.DATABASE_URL});
      const db=new PrismaClient({adapter:new PrismaLibSQL(client)});
      (async()=>{${body}})().then(()=>db.$disconnect()).then(()=>client.close()).catch(error=>{console.error(error);process.exitCode=1});
    `
      ],
      { env, encoding: 'utf8' }
    )
    assert.equal(child.status, 0, child.stderr)
    return JSON.parse(child.stdout || 'null')
  }
  const snapshot = () =>
    inspect(`
    const user=await db.user.findUnique({where:{email:process.env.SEED_EMAIL},include:{
      tags:{orderBy:{position:'asc'},include:{references:true}},
      transactions:{orderBy:{clientId:'asc'},include:{tags:{include:{tag:true}}}},
      recurringRules:{orderBy:{description:'asc'},include:{exceptions:{include:{tags:{include:{tag:true}}}}}},
      budgets:true,categories:true
    }});
    const tagNames=links=>links.map(link=>link.tag.name).sort();
    const rows=user.transactions.map(row=>({date:row.date,amount:row.amount,type:row.type,comment:row.description,tags:tagNames(row.tags)}));
    const rules=user.recurringRules.map(rule=>({name:rule.description,amount:rule.amount,start:rule.startDate,next:rule.nextDate,cursor:rule.lastProcessedDate,
      exceptions:rule.exceptions.map(item=>({kind:item.kind,date:item.date,comment:item.comment,amount:item.amount,tags:tagNames(item.tags)}))}));
    const foreignKeys=await client.execute('PRAGMA foreign_key_check');
    console.log(JSON.stringify({id:user.id,count:rows.length,categories:user.categories.length,budgets:user.budgets.length,
      tags:user.tags.map(tag=>({name:tag.name,position:tag.position,aliases:tag.references.length})),
      first:rows.map(row=>row.date.toISOString()).sort()[0],last:rows.map(row=>row.date.toISOString()).sort().at(-1),
      midnight:rows.every(row=>row.date.toISOString().endsWith('T00:00:00.000Z')),
      wholeCents:rows.every(row=>Number.isInteger(row.amount)),
      maxTags:Math.max(...rows.map(row=>row.tags.length)),untagged:rows.some(row=>!row.tags.length),
      blankIncome:rows.some(row=>row.type==='INCOME'&&!row.comment),blankExpense:rows.some(row=>row.type==='EXPENSE'&&!row.comment),
      rules,foreignKeys:foreignKeys.rows.length,
      digest:createHash('sha256').update(JSON.stringify({rows,rules,tags:user.tags.map(tag=>tag.name)})).digest('hex')}));
  `)

  const { user: tagOnly } = await createTestUser(ctx, 'tag-only-seed@example.com')
  await ctx.call('POST', '/api/tags', { id: 'tag-only-reference', name: 'Only tag' })
  assert.match(seed(false, { SEED_EMAIL: tagOnly.email }), /skipped/)
  assert.equal(
    await inspect(
      `console.log(JSON.stringify(await db.tag.count({where:{userId:${tagOnly.id}}})));`
    ),
    1
  )

  seed()
  const first = await snapshot()
  const today = calendarToday('America/Lima')
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 23, 1))
  assert.equal(first.first.slice(0, 10), isoDay(start))
  assert.equal(first.last.slice(0, 10), isoDay(today))
  assert.ok(first.count > 500)
  assert.equal(first.categories, 9)
  assert.equal(first.budgets, 5)
  assert.equal(first.tags.length, 8)
  assert.deepEqual(
    first.tags.map(tag => tag.position),
    [0, 1, 2, 3, 4, 5, 6, 7]
  )
  assert.ok(first.tags.every(tag => tag.aliases === 1))
  assert.equal(first.maxTags, 5)
  for (const key of ['untagged', 'blankIncome', 'blankExpense', 'midnight', 'wholeCents'])
    assert.equal(first[key], true, key)
  assert.equal(first.foreignKeys, 0)
  assert.equal(first.rules.length, 4)
  assert.ok(first.rules.every(rule => rule.next.slice(0, 10) > isoDay(today)))
  const lunch = first.rules.find(rule => rule.name === 'Weekly lunch')
  assert.equal(lunch.amount, 3500)
  assert.equal(lunch.exceptions[0].kind, 'EDIT')
  assert.equal(lunch.exceptions[0].amount, 6000)
  assert.equal(lunch.exceptions[0].tags.length, 2)
  const commute = first.rules.find(rule => rule.name === 'Weekly commute')
  assert.equal(commute.exceptions[0].kind, 'SKIP')
  assert.equal(commute.cursor, null)
  assert.equal(new Date(commute.next) - new Date(commute.exceptions[0].date), 7 * 86400000)
  assert.ok(
    first.rules
      .filter(rule => ['Rent', 'Monthly salary'].includes(rule.name))
      .every(rule => rule.cursor)
  )

  assert.match(seed(), /skipped/)
  assert.deepEqual(await snapshot(), first)
  seed(true)
  const reset = await snapshot()
  assert.notEqual(reset.id, first.id)
  assert.equal(reset.digest, first.digest)
  assert.equal(reset.count, first.count)
  assert.equal(reset.foreignKeys, 0)

  // Failure after deleting the previous account must restore ALL of its data.
  await inspect(
    `await client.execute("CREATE TRIGGER seed_failure BEFORE INSERT ON Tag WHEN NEW.name = 'Work' BEGIN SELECT RAISE(ABORT, 'intentional seed failure'); END");`
  )
  seed(true, {}, 1)
  assert.deepEqual(await snapshot(), reset)
  await inspect(`await client.execute('DROP TRIGGER seed_failure');`)
  seed(true, { SEED_MONTHS: 'NaN' }, 1)
  seed(true, { SEED_TIME_ZONE: 'Invalid/Zone' }, 1)
  assert.deepEqual(await snapshot(), reset)

  // Real readers should not materialize duplicate historical occurrences.
  const login = await ctx.call('POST', '/auth/login', {
    email: env.SEED_EMAIL,
    password: env.SEED_PASSWORD
  })
  assert.equal(login.status, 200)
  ctx.state.token = login.data.token
  const headers = { 'X-Porkex-Time-Zone': 'America/Lima' }
  const rules = await ctx.call('GET', '/api/recurring', null, headers)
  assert.equal(rules.status, 200)
  assert.equal(
    rules.data.find(rule => rule.description === 'Weekly lunch').nextException.amount,
    60
  )
  for (const mode of ['year', 'week']) {
    const comparison = await ctx.call(
      'GET',
      `/api/analytics/comparison?mode=${mode}`,
      null,
      headers
    )
    assert.equal(comparison.status, 200)
    assert.ok(comparison.data.current.count > 0)
    assert.ok(comparison.data.previous.count > 0)
  }
  assert.equal((await snapshot()).count, reset.count)
  const kept = await inspect(`
    const user=await db.user.findUnique({where:{id:${keeper.id}},include:{transactions:{include:{tags:true}},tags:true}});
    console.log(JSON.stringify({email:user.email,amount:user.transactions[0].amount,links:user.transactions[0].tags.length,tags:user.tags.length}));
  `)
  assert.deepEqual(kept, { email: keeper.email, amount: 1234, links: 1, tags: 1 })
  console.log(
    'PASS seed: new features, UTC calendar, year/week history, deterministic reset, skip, account isolation and atomic rollback'
  )
})
