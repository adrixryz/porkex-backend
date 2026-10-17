// Exercises the real materializer against the isolated suite database, with
// explicit instants rather than changing the application's system clock.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

process.env.DATABASE_URL = process.argv[2]
delete process.env.TURSO_AUTH_TOKEN
const require = createRequire(import.meta.url)
require('ts-node/register/transpile-only')
const { prisma } = require('../src/lib/prisma.ts')
const { runDueRules } = require('../src/lib/recurring.ts')

for (const [zone, day, instants] of [
  [
    'America/Lima',
    '2026-10-18',
    ['2026-10-18T00:00:00Z', '2026-10-18T05:00:00Z', '2026-10-18T05:00:01Z']
  ],
  [
    'America/New_York',
    '2026-03-08',
    ['2026-03-08T04:59:59Z', '2026-03-08T05:00:00Z', '2026-03-08T07:00:00Z']
  ],
  [
    'America/New_York',
    '2026-11-01',
    ['2026-11-01T03:59:59Z', '2026-11-01T04:00:00Z', '2026-11-01T06:00:00Z']
  ]
]) {
  const user = await prisma.user.create({
    data: { name: 'Clock', email: `${zone}-${day}@example.com`, password: 'unused' }
  })
  const category = await prisma.category.create({
    data: { name: 'Clock', type: 'EXPENSE', userId: user.id }
  })
  const rule = await prisma.recurringRule.create({
    data: {
      userId: user.id,
      categoryId: category.id,
      amount: 100,
      type: 'EXPENSE',
      description: 'Clock',
      frequency: 'DAY',
      startDate: new Date(`${day}T00:00:00Z`),
      nextDate: new Date(`${day}T00:00:00Z`)
    }
  })
  const created = []
  for (const instant of instants)
    created.push((await runDueRules(user.id, new Date(instant), zone)).created)
  assert.deepEqual(created, [0, 1, 0], `${zone} ${day}: local midnight only`)
  const rows = await prisma.transaction.findMany({ where: { recurringId: rule.id } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].date.toISOString(), `${day}T00:00:00.000Z`)
  // An injected SQLite insert failure must roll back the cursor and rows
  // together, ready for a later retry.
  await prisma.recurringRule.update({
    where: { id: rule.id },
    data: { nextDate: new Date(`${day}T00:00:00Z`), lastProcessedDate: null }
  })
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER "fail_clock_${rule.id}" BEFORE INSERT ON "Transaction" WHEN NEW."recurringId" = ${rule.id} BEGIN SELECT RAISE(ABORT, 'test failure'); END`
  )
  // Existing first date is skipped; the following day is attempted and fails.
  const tomorrow = new Date(new Date(instants[2]).getTime() + 86400000)
  await assert.rejects(runDueRules(user.id, tomorrow, zone))
  const unchanged = await prisma.recurringRule.findUnique({ where: { id: rule.id } })
  assert.equal(unchanged.nextDate.toISOString(), `${day}T00:00:00.000Z`)
  assert.equal(unchanged.lastProcessedDate, null)
  assert.equal(await prisma.transaction.count({ where: { recurringId: rule.id } }), 1)
  await prisma.$executeRawUnsafe(`DROP TRIGGER "fail_clock_${rule.id}"`)
}
await prisma.$disconnect()
console.log(
  'PASS recurring materialization uses local midnight across Lima and DST; failed batches roll back'
)
