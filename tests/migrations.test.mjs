import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import schema from '../scripts/lib/schema.js'
import migrations from '../scripts/lib/migrations.js'

if (!process.env.PORKEX_MIGRATION_TEST_DIR) {
  const directory = mkdtempSync(join(tmpdir(), 'porkex-migration-'))
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      stdio: 'inherit',
      env: { ...process.env, PORKEX_MIGRATION_TEST_DIR: directory }
    })
    process.exitCode = child.status ?? 1
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  process.exit(process.exitCode)
}

const client = createClient({
  url: `file:${join(process.env.PORKEX_MIGRATION_TEST_DIR, 'upgrade.db').replace(/\\/g, '/')}`,
  intMode: 'bigint'
})
try {
  await schema.initializeDatabase(client, { schemaPath: resolve('prisma/baselines/1.0.0.prisma') })
  await client.execute(
    "INSERT INTO User (name,email,password) VALUES ('Owner','owner@example.test','hash')"
  )
  await client.execute(
    "INSERT INTO Account (id,userId,name,openingBalance,isMain) VALUES ('main-1',1,'Main',12345,1)"
  )
  const before = await client.execute('SELECT * FROM User')
  await assert.rejects(schema.checkDatabaseSchema(client), /Database is not ready/)
  const backup = join(process.env.PORKEX_MIGRATION_TEST_DIR, 'before.db')
  const upgrade = spawnSync(process.execPath, ['scripts/migrate-db.js', '--backup', backup], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: `file:${join(process.env.PORKEX_MIGRATION_TEST_DIR, 'upgrade.db').replace(/\\/g, '/')}`,
      TURSO_AUTH_TOKEN: ''
    }
  })
  assert.equal(upgrade.status, 0, upgrade.stderr)
  assert.match(upgrade.stdout, /Restore verified/)
  assert.match(upgrade.stdout, /Applied 2 migrations/)
  await schema.checkDatabaseSchema(client)
  const after = (await client.execute('SELECT * FROM User')).rows[0]
  assert.equal(after.language, 'en')
  for (const [key, value] of Object.entries(before.rows[0])) assert.equal(after[key], value)
  assert.equal(
    (await client.execute('SELECT openingBalance FROM Account')).rows[0].openingBalance,
    12345n
  )
  assert.equal((await migrations.migrateDatabase(client)).applied, 0)
  await client.execute("UPDATE _PorkexSchemaMigration SET checksum='corrupt'")
  await assert.rejects(schema.checkDatabaseSchema(client), /checksum/)
  await assert.rejects(migrations.migrateDatabase(client), /checksum/)
  assert.equal(
    (await client.execute('SELECT openingBalance FROM Account')).rows[0].openingBalance,
    12345n
  )
  console.log('PASS migrations: v1.0.0 upgrade, data preservation, replay and checksum refusal')
} finally {
  client.close()
}

const intermediate = createClient({
  url: `file:${join(process.env.PORKEX_MIGRATION_TEST_DIR, 'intermediate.db').replace(/\\/g, '/')}`,
  intMode: 'bigint'
})
try {
  await schema.initializeDatabase(intermediate, {
    schemaPath: resolve('prisma/migrations/001_recurring_tags/schema.prisma')
  })
  await migrations.createLedger(intermediate, migrations.loadMigrations().slice(0, 1))
  await intermediate.execute(
    "INSERT INTO User (name,email,password) VALUES ('Owner','owner2@example.test','hash')"
  )
  await intermediate.execute(
    "INSERT INTO Category (id,name,type,userId) VALUES (1,'Food','Expense',1)"
  )
  await intermediate.execute(
    "INSERT INTO Tag (id,userId,name,normalizedName,position) VALUES ('tag',1,'Home','home',0)"
  )
  await intermediate.execute(
    "INSERT INTO RecurringRule (id,userId,categoryId,amount,type,description,startDate,nextDate,updatedAt) VALUES (1,1,1,100,'Expense','Rent','2027-01-01','2027-01-01','2026-01-01')"
  )
  await intermediate.execute("INSERT INTO RecurringTag (ruleId,tagId) VALUES (1,'tag')")
  assert.equal((await migrations.migrateDatabase(intermediate)).applied, 1)
  await schema.checkDatabaseSchema(intermediate)
  assert.equal((await intermediate.execute('SELECT tagId FROM RecurringTag')).rows[0].tagId, 'tag')
  assert.equal((await intermediate.execute('SELECT language FROM User')).rows[0].language, 'en')
  console.log('PASS migrations: upgrade from the first incremental schema preserves recurring tags')
} finally {
  intermediate.close()
}
