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
  assert.match(upgrade.stdout, /Applied 1 migrations/)
  await schema.checkDatabaseSchema(client)
  assert.deepEqual((await client.execute('SELECT * FROM User')).rows, before.rows)
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
