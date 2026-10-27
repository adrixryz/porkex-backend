const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { BACKEND_DIR } = require('./database')
const { buildReference, describe, sameSchema, schemaFingerprint } = require('./schema')

const directory = path.join(BACKEND_DIR, 'prisma', 'migrations')
const baseline = path.join(BACKEND_DIR, 'prisma', 'baselines', '1.0.0.prisma')
const current = path.join(BACKEND_DIR, 'prisma', 'schema.prisma')
const ledger = '_PorkexSchemaMigration'
const ledgerSql = `CREATE TABLE "${ledger}" ("id" TEXT NOT NULL PRIMARY KEY, "checksum" TEXT NOT NULL)`
const normalize = value => value.replace(/\r\n/g, '\n')
const hash = value => createHash('sha256').update(normalize(value)).digest('hex')

function loadMigrations() {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  const migrations = entries
    .map(entry => {
      if (!entry.isDirectory() || !/^\d{3}_[a-z0-9_]+$/.test(entry.name))
        throw new Error(`Invalid migration entry: ${entry.name}`)
      const folder = path.join(directory, entry.name)
      const sql = fs.readFileSync(path.join(folder, 'migration.sql'), 'utf8')
      const snapshot = path.join(folder, 'schema.prisma')
      const source = fs.readFileSync(snapshot, 'utf8')
      return { id: entry.name, sql, snapshot, checksum: hash(`${sql}\n-- schema --\n${source}`) }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  for (let i = 0; i < migrations.length; i++) {
    if (Number(migrations[i].id.slice(0, 3)) !== i + 1)
      throw new Error('Migration numbers must be consecutive and immutable.')
  }
  if (
    !migrations.length ||
    schemaFingerprint(migrations.at(-1).snapshot) !== schemaFingerprint(current)
  )
    throw new Error('The current schema is not the last migration snapshot.')
  return migrations
}

// CREATE TABLE text differs between a freshly generated table and ALTER TABLE.
// Compare columns, keys and indexes while still rejecting unmodelled constraints.
function semantic(schema) {
  return schema.map(({ sql, ...table }) => ({
    ...table,
    autoincrement: /\bAUTOINCREMENT\b/i.test(sql),
    withoutRowid: /\bWITHOUT ROWID\b/i.test(sql),
    strict: /\)\s*STRICT\s*$/i.test(sql),
    unsupported:
      /\bCHECK\s*\(|\bGENERATED\b|\bCOLLATE\b|\bUNIQUE\b|\bDEFERRABLE\b|\bON CONFLICT\b/i.test(sql)
  }))
}

async function referenceVersions(migrations = loadMigrations()) {
  const reference = await buildReference(baseline)
  try {
    const versions = [await describe(reference.client)]
    for (const migration of migrations) {
      await reference.client.executeMultiple(migration.sql)
      const version = await describe(reference.client)
      const snapshot = await buildReference(migration.snapshot)
      try {
        if (!sameSchema(semantic(version), semantic(snapshot.schema)))
          throw new Error(`Migration ${migration.id} does not match its schema snapshot.`)
      } finally {
        snapshot.client.close()
      }
      versions.push(version)
    }
    return versions
  } finally {
    reference.client.close()
  }
}

async function createLedger(db, migrations = loadMigrations()) {
  await db.execute(ledgerSql)
  for (const migration of migrations)
    await db.execute({
      sql: `INSERT INTO "${ledger}" (id, checksum) VALUES (?, ?)`,
      args: [migration.id, migration.checksum]
    })
}

async function readLedger(db, migrations = loadMigrations()) {
  const found = await db.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
    args: [ledger]
  })
  if (!found.rows.length) return null
  const normalSql = sql => String(sql).replace(/\s+/g, ' ').trim().replace(/;$/, '')
  if (normalSql(found.rows[0].sql) !== normalSql(ledgerSql))
    throw new Error('The migration ledger structure has changed.')
  const rows = (await db.execute(`SELECT id, checksum FROM "${ledger}" ORDER BY id`)).rows
  if (
    rows.length > migrations.length ||
    rows.some(
      (row, index) => row.id !== migrations[index].id || row.checksum !== migrations[index].checksum
    )
  )
    throw new Error('Migration history or checksum mismatch.')
  return rows
}

async function checkLedger(db) {
  const migrations = loadMigrations()
  const rows = await readLedger(db, migrations)
  if (!rows || rows.length !== migrations.length)
    throw new Error('The database has pending or missing migrations.')
}

async function migrateDatabase(client) {
  const migrations = loadMigrations()
  const versions = await referenceVersions(migrations)
  const transaction = await client.transaction('write')
  try {
    const legacy = await transaction.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_PorkexMigration'"
    )
    if (legacy.rows.length) throw new Error('A legacy migration ledger requires manual inspection.')
    const states = await transaction.execute(
      'SELECT fingerprint, structure FROM "_PorkexDevelopmentSchema" WHERE id=1'
    )
    const state = states.rows[0]
    if (!state) throw new Error('The database does not have the v1.0.0 schema state.')
    const applied = await readLedger(transaction, migrations)
    const count = applied?.length ?? 0
    const expectedFingerprint = schemaFingerprint(count ? migrations[count - 1].snapshot : baseline)
    const live = await describe(transaction)
    if (
      state.fingerprint !== expectedFingerprint ||
      !sameSchema(live, JSON.parse(String(state.structure))) ||
      !sameSchema(semantic(live), semantic(versions[count]))
    )
      throw new Error('The database schema or recorded state has drifted; migration refused.')
    if (!applied) await transaction.execute(ledgerSql)
    for (let index = count; index < migrations.length; index++) {
      const migration = migrations[index]
      await transaction.executeMultiple(migration.sql)
      if (!sameSchema(semantic(await describe(transaction)), semantic(versions[index + 1])))
        throw new Error(`Migration ${migration.id} produced an unexpected schema.`)
      await transaction.execute({
        sql: `INSERT INTO "${ledger}" (id, checksum) VALUES (?, ?)`,
        args: [migration.id, migration.checksum]
      })
    }
    if ((await transaction.execute('PRAGMA foreign_key_check')).rows.length)
      throw new Error('Foreign-key check failed; migration rolled back.')
    const integrity = await transaction.execute('PRAGMA integrity_check')
    if (integrity.rows.length !== 1 || integrity.rows[0][0] !== 'ok')
      throw new Error('Integrity check failed; migration rolled back.')
    const result = await describe(transaction)
    await transaction.execute({
      sql: 'UPDATE "_PorkexDevelopmentSchema" SET fingerprint=?, structure=? WHERE id=1',
      args: [schemaFingerprint(current), JSON.stringify(result)]
    })
    await transaction.commit()
    return { applied: migrations.length - count, total: migrations.length }
  } catch (error) {
    await transaction.rollback()
    throw error
  } finally {
    transaction.close()
  }
}

module.exports = { loadMigrations, referenceVersions, createLedger, checkLedger, migrateDatabase }
