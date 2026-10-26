import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import schemaApi from '../scripts/lib/schema.js'

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!process.env.PORKEX_SCHEMA_TEST_DIRECTORY) {
  const directory = mkdtempSync(join(tmpdir(), 'porkex-schema-'))
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: backend,
      stdio: 'inherit',
      env: { ...process.env, PORKEX_SCHEMA_TEST_DIRECTORY: directory }
    })
    process.exitCode = child.status || (child.error ? 1 : 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  process.exit(process.exitCode)
}
// A worker owns all native handles; the parent removes files only after it exits.
const temporary = process.env.PORKEX_SCHEMA_TEST_DIRECTORY
const client = createClient({
  url: `file:${join(temporary, 'schema.db').replace(/\\/g, '/')}`,
  intMode: 'bigint'
})
try {
  await assert.rejects(schemaApi.checkDatabaseSchema(client), /Database is not ready/)
  assert.equal((await schemaApi.initializeDatabase(client)).created, true)
  await schemaApi.checkDatabaseSchema(client)
  await client.execute(
    "INSERT INTO User (id,name,email,password) VALUES (1,'Disposable','owner@example.test','hash')"
  )
  assert.equal((await schemaApi.initializeDatabase(client)).created, false)
  assert.equal((await client.execute('SELECT COUNT(*) n FROM User')).rows[0].n, 1n)
  assert.equal(
    (await client.execute("SELECT name FROM sqlite_master WHERE name='_PorkexMigration'")).rows
      .length,
    0
  )

  await client.execute('ALTER TABLE Category ADD COLUMN unexpected TEXT')
  await assert.rejects(schemaApi.checkDatabaseSchema(client), /structure changed/)
  await assert.rejects(schemaApi.initializeDatabase(client), /Database is not ready/)
  assert.equal((await client.execute('SELECT COUNT(*) n FROM User')).rows[0].n, 1n)
  await schemaApi.initializeDatabase(client, { reset: true })
  await schemaApi.checkDatabaseSchema(client)
  assert.equal((await client.execute('SELECT COUNT(*) n FROM User')).rows[0].n, 0n)

  // An explicit reset must still roll back if an unrelated table would be left behind.
  await client.execute(
    "INSERT INTO User (id,name,email,password) VALUES (1,'Kept on failure','kept@example.test','hash')"
  )
  await client.execute('CREATE TABLE Unrelated (id INTEGER PRIMARY KEY)')
  await assert.rejects(
    schemaApi.initializeDatabase(client, { reset: true }),
    /differs from schema.prisma/
  )
  assert.equal(
    (await client.execute('SELECT name FROM User WHERE id=1')).rows[0].name,
    'Kept on failure'
  )
  await client.execute('DROP TABLE Unrelated')

  // A database created by the old workflow is not silently adopted or erased.
  await client.execute('DROP TABLE _PorkexDevelopmentSchema')
  await client.execute('CREATE TABLE _PorkexMigration (id TEXT PRIMARY KEY, checksum TEXT)')
  await assert.rejects(schemaApi.initializeDatabase(client), /Database is not ready/)
  await schemaApi.initializeDatabase(client, { reset: true })
  assert.equal(
    (await client.execute("SELECT name FROM sqlite_master WHERE name='_PorkexMigration'")).rows
      .length,
    0
  )

  const changedSchema = join(temporary, 'changed.prisma')
  writeFileSync(
    changedSchema,
    readFileSync(join(backend, 'prisma/schema.prisma'), 'utf8').replace(
      '@default("USD")',
      '@default("EUR")'
    )
  )
  await assert.rejects(
    schemaApi.checkDatabaseSchema(client, changedSchema),
    /current schema.prisma/
  )
  await schemaApi.initializeDatabase(client, { reset: true, schemaPath: changedSchema })
  await schemaApi.checkDatabaseSchema(client, changedSchema)
  await assert.rejects(schemaApi.checkDatabaseSchema(client), /current schema.prisma/)

  const offline = spawnSync(process.execPath, ['scripts/apply-schema.js', '--check'], {
    cwd: backend,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: 'libsql://must-not-contact.invalid',
      TURSO_AUTH_TOKEN: 'unused-test-token'
    }
  })
  assert.equal(offline.status, 0, offline.stderr)
  assert.match(offline.stdout, /generated from schema.prisma/)
  console.log(
    'PASS development schema: explicit setup/reset, startup guard, drift, rollback, old-ledger cleanup and offline generation'
  )
} finally {
  client.close()
}
