import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import migrationsApi from '../scripts/lib/migrations.js'

const { loadMigrations, describe, sameSchema, buildReference, checkPrismaSchema, runMigrations } =
  migrationsApi
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrations = loadMigrations()
const baseline = migrations[0].sql
const clients = []
if (!process.env.PORKEX_MIGRATIONS_TEST_DIRECTORY) {
  const directory = mkdtempSync(join(tmpdir(), 'porkex-migrations-'))
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: backend,
      stdio: 'inherit',
      env: { ...process.env, PORKEX_MIGRATIONS_TEST_DIRECTORY: directory }
    })
    process.exitCode = child.status || (child.error ? 1 : 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  process.exit(process.exitCode)
}
// The parent removes files after this worker exits and releases native handles.
const temporary = process.env.PORKEX_MIGRATIONS_TEST_DIRECTORY

async function memory(sql = '') {
  const client = createClient({
    url: `file:${join(temporary, `test-${clients.length}.db`).replace(/\\/g, '/')}`,
    intMode: 'bigint'
  })
  clients.push(client)
  if (sql) await client.executeMultiple(sql)
  return client
}

async function catalog(client) {
  return JSON.stringify(
    (await client.execute('SELECT name, sql FROM sqlite_master ORDER BY name')).rows
  )
}

async function seed(client) {
  await client.executeMultiple(`
    INSERT INTO "User" (id,name,email,password) VALUES(1,'Personal','owner@example.com','hash');
    INSERT INTO "Category" (id,name,type,userId) VALUES(1,'Food','EXPENSE',1);
    INSERT INTO "RecurringRule" (id,userId,categoryId,amount,type,description,startDate,nextDate,updatedAt)
      VALUES(1,1,1,100,'EXPENSE','monthly',1767225600000,1793491200000,1767225600000),
            (2,1,1,200,'EXPENSE','no history',1767225600000,1793491200000,1767225600000);
    INSERT INTO "Transaction" (id,amount,type,description,date,categoryId,userId,recurringId)
      VALUES(1,100,'EXPENSE','old',1767225600000,1,1,1),
            (2,100,'EXPENSE','new',1769904000000,1,1,1),
            (99,100,'EXPENSE','deleted',1769904000000,1,1,NULL);
    DELETE FROM "Transaction" WHERE id=99;
  `)
}

try {
  const fresh = await memory()
  assert.equal((await runMigrations(fresh, migrations)).applied, migrations.length)
  assert.equal((await runMigrations(fresh, migrations)).applied, 0)
  assert.equal(
    (await fresh.execute('SELECT COUNT(*) AS count FROM _PorkexMigration')).rows[0].count,
    BigInt(migrations.length)
  )

  const existing = await memory(baseline)
  await seed(existing)
  assert.equal((await runMigrations(existing, migrations)).applied, migrations.length - 1)
  const watermarks = (
    await existing.execute('SELECT id,lastProcessedDate FROM RecurringRule ORDER BY id')
  ).rows
  assert.equal(watermarks[0].lastProcessedDate, 1769904000000n)
  assert.equal(watermarks[1].lastProcessedDate, null)
  assert.equal(
    (await existing.execute('SELECT COUNT(*) AS count FROM "Transaction"')).rows[0].count,
    2n
  )
  assert.equal(
    (await existing.execute("SELECT seq FROM sqlite_sequence WHERE name='Transaction'")).rows[0]
      .seq,
    99n
  )
  await existing.execute({
    sql: 'UPDATE _PorkexMigration SET checksum=? WHERE id=?',
    args: ['changed', migrations[0].id]
  })
  const badHistory = await catalog(existing)
  await assert.rejects(runMigrations(existing, migrations), /checksum mismatch/)
  assert.equal(await catalog(existing), badHistory)

  // This is the documented historical additive layout: clientId/recurringId
  // were appended to Transaction and recurringId never acquired its FK.
  let legacySql = baseline.replace(/,\n\s*CONSTRAINT "Transaction_recurringId_fkey"[^\n]+/, '')
  legacySql = legacySql.replace(
    '    "clientId" TEXT,\n    "description" TEXT NOT NULL,\n    "date"',
    '    "description" TEXT NOT NULL,\n    "date"'
  )
  legacySql = legacySql.replace(
    '    "recurringId" INTEGER,',
    '    "clientId" TEXT,\n    "recurringId" INTEGER,'
  )
  const legacy = await memory(legacySql)
  await seed(legacy)
  await runMigrations(legacy, migrations)
  assert.equal(
    (await legacy.execute('PRAGMA foreign_key_list("Transaction")')).rows.some(
      row => row.from === 'recurringId'
    ),
    true
  )
  assert.equal(
    (await legacy.execute('SELECT description FROM "Transaction" WHERE id=2')).rows[0].description,
    'new'
  )
  assert.equal(
    (await legacy.execute("SELECT seq FROM sqlite_sequence WHERE name='Transaction'")).rows[0].seq,
    99n
  )
  assert.equal(
    (await legacy.execute('SELECT lastProcessedDate FROM RecurringRule WHERE id=1')).rows[0]
      .lastProcessedDate,
    1769904000000n
  )

  for (const edit of [
    sql =>
      sql.replace(
        '"currency" TEXT NOT NULL DEFAULT \'USD\'',
        '"currency" TEXT NOT NULL DEFAULT \'PEN\''
      ),
    sql => sql.replace('"currency" TEXT NOT NULL', '"currency" TEXT'),
    sql => sql.replace('"amount" INTEGER NOT NULL', '"amount" REAL NOT NULL'),
    sql => sql.replace('CREATE UNIQUE INDEX "User_email_key"', 'CREATE INDEX "User_email_key"'),
    sql => sql.replace('ON DELETE SET NULL', 'ON DELETE CASCADE'),
    sql => sql.replace('"name" TEXT NOT NULL,', '"name" TEXT NOT NULL UNIQUE,'),
    sql => sql + '\nALTER TABLE "User" ADD COLUMN surprise TEXT;',
    sql => sql + '\nCREATE TABLE Extra(id INTEGER);',
    sql => sql + '\nCREATE TRIGGER surprise AFTER UPDATE ON "User" BEGIN SELECT 1; END;'
  ]) {
    const drifted = await memory(edit(baseline))
    const before = await catalog(drifted)
    await assert.rejects(
      runMigrations(drifted, migrations),
      /Unknown existing schema|Unexpected schema object/
    )
    assert.equal(await catalog(drifted), before)
    assert.equal(
      (await drifted.execute("SELECT name FROM sqlite_master WHERE name='_PorkexMigration'")).rows
        .length,
      0
    )
  }

  const postMigrationDrift = await memory()
  await runMigrations(postMigrationDrift, migrations)
  await postMigrationDrift.execute('DROP INDEX User_email_key')
  const beforeDrift = await catalog(postMigrationDrift)
  await assert.rejects(runMigrations(postMigrationDrift, migrations), /schema drift/)
  assert.equal(await catalog(postMigrationDrift), beforeDrift)

  const orphan = await memory(legacySql)
  await seed(orphan)
  await orphan.execute('UPDATE "Transaction" SET recurringId=999 WHERE id=1')
  const beforeOrphan = await catalog(orphan)
  await assert.rejects(runMigrations(orphan, migrations), /FOREIGN KEY|foreign-key/i)
  assert.equal(await catalog(orphan), beforeOrphan)
  assert.equal(
    (await orphan.execute('SELECT recurringId FROM "Transaction" WHERE id=1')).rows[0].recurringId,
    999n
  )

  // A migration that succeeds on empty reference data but fails against real
  // rows must roll back both its DDL and ledger, including baseline adoption.
  const rollback = await memory(baseline)
  await seed(rollback)
  const sql = 'CREATE TABLE Probe(id INTEGER); UPDATE "User" SET currency=NULL;'
  const failing = {
    id: '003_failure',
    sql,
    checksum: createHash('sha256').update(sql).digest('hex')
  }
  const beforeFailure = await catalog(rollback)
  await assert.rejects(runMigrations(rollback, [...migrations, failing]), /NOT NULL/)
  assert.equal(await catalog(rollback), beforeFailure)
  assert.equal((await rollback.execute('SELECT currency FROM "User"')).rows[0].currency, 'USD')

  const expected = await buildReference(migrations)
  try {
    assert.equal(sameSchema(await describe(legacy), expected.versions.at(-1)), true)
    await checkPrismaSchema(expected.versions.at(-1))
    const wrongSchema = join(temporary, 'wrong.prisma')
    writeFileSync(
      wrongSchema,
      'datasource db {\n provider = "sqlite"\n url = env("DATABASE_URL")\n}\nmodel Wrong {\n id Int @id\n}\n'
    )
    await assert.rejects(
      checkPrismaSchema(expected.versions.at(-1), wrongSchema),
      /differs from versioned migrations/
    )
  } finally {
    expected.client.close()
  }

  const cli = spawnSync(process.execPath, ['scripts/apply-schema.js'], {
    cwd: backend,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: `file:${join(temporary, 'fresh.db').replace(/\\/g, '/')}`,
      TURSO_AUTH_TOKEN: ''
    }
  })
  assert.equal(cli.status, 0, cli.stderr)
  assert.match(cli.stdout, /Migrations applied/)
  const check = spawnSync(process.execPath, ['scripts/apply-schema.js', '--check'], {
    cwd: backend,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: 'libsql://must-never-connect.invalid',
      TURSO_AUTH_TOKEN: 'not-a-real-token'
    }
  })
  assert.equal(check.status, 0, check.stderr)
  console.log(
    'PASS migrations: fresh, adoption, legacy normalization, UTC watermark, drift, checksums, rollback and offline Prisma check'
  )
} finally {
  for (const client of clients) client.close()
}
