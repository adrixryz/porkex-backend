const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { BACKEND_DIR, createClient, quoteIdentifier } = require('./database')

const SCHEMA_FILE = path.join(BACKEND_DIR, 'prisma', 'schema.prisma')
const STATE_TABLE = '_PorkexDevelopmentSchema'
const LEGACY_LEDGER = '_PorkexMigration'
const APPLICATION_TABLES = [
  'Favorite',
  'FinancialEdit',
  'BalanceAdjustment',
  'FinancialReceipt',
  'Transfer',
  'OccurrenceTag',
  'OccurrenceOverride',
  'TransactionTag',
  'TagReference',
  'Tag',
  'Transaction',
  'RecurringRule',
  'Budget',
  'Category',
  'Account',
  'User'
]

function schemaFingerprint(schemaPath = SCHEMA_FILE) {
  const source = fs.readFileSync(schemaPath, 'utf8').replace(/\r\n/g, '\n')
  return createHash('sha256').update(source).digest('hex')
}

function generateSchemaSql(schemaPath = SCHEMA_FILE) {
  // Prisma is a DDL generator here; no database or migration history is consulted.
  const result = spawnSync(
    process.execPath,
    [
      require.resolve('prisma/build/index.js'),
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema',
      schemaPath,
      '--script'
    ],
    {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'file::memory:', TURSO_AUTH_TOKEN: '' }
    }
  )
  if (result.error || result.status !== 0)
    throw new Error(
      'Could not generate the development schema: ' + (result.error?.message || result.stderr)
    )
  return result.stdout
}

function normalizeSql(sql) {
  return sql?.replace(/\s+/g, ' ').trim().replace(/;$/, '') || null
}

function canonicalDefault(value) {
  if (value === null) return null
  const text = String(value)
    .trim()
    .replace(/^\((.*)\)$/, '$1')
  return text.startsWith("'") ? text : text.toUpperCase()
}

async function describe(client) {
  const catalog = (
    await client.execute(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
  ).rows.filter(
    row =>
      ![STATE_TABLE, LEGACY_LEDGER].includes(row.name) &&
      ![STATE_TABLE, LEGACY_LEDGER].includes(row.tbl_name)
  )
  const unexpected = catalog.find(row => row.type !== 'table' && row.type !== 'index')
  if (unexpected) throw new Error(`Unexpected schema object: ${unexpected.name}`)
  const tables = catalog.filter(row => row.type === 'table')
  const statements = tables.flatMap(table => [
    `PRAGMA table_xinfo(${quoteIdentifier(table.name)})`,
    `PRAGMA foreign_key_list(${quoteIdentifier(table.name)})`
  ])
  const results = statements.length ? await client.batch(statements) : []
  return tables
    .map((table, index) => ({
      name: table.name,
      columns: results[index * 2].rows
        .map(row => ({
          name: row.name,
          type: row.type.toUpperCase(),
          notnull: Number(row.notnull),
          default: canonicalDefault(row.dflt_value),
          pk: Number(row.pk),
          hidden: Number(row.hidden)
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      foreignKeys: results[index * 2 + 1].rows
        .map(row => ({
          table: row.table,
          from: row.from,
          to: row.to,
          onUpdate: row.on_update,
          onDelete: row.on_delete,
          match: row.match
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      indexes: catalog
        .filter(row => row.type === 'index' && row.tbl_name === table.name)
        .map(row => ({ name: row.name, sql: normalizeSql(row.sql) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      sql: normalizeSql(table.sql)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function sameSchema(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function buildReference(schemaPath = SCHEMA_FILE) {
  const sql = generateSchemaSql(schemaPath)
  const client = createClient({ url: 'file::memory:', intMode: 'bigint' })
  try {
    await client.executeMultiple(sql)
    return {
      client,
      sql,
      schema: await describe(client),
      fingerprint: schemaFingerprint(schemaPath)
    }
  } catch (error) {
    client.close()
    throw error
  }
}

async function checkDatabaseSchema(client, schemaPath = SCHEMA_FILE) {
  try {
    const result = await client.execute(
      `SELECT fingerprint, structure FROM "${STATE_TABLE}" WHERE id=1`
    )
    const state = result.rows[0]
    if (!state || state.fingerprint !== schemaFingerprint(schemaPath))
      throw new Error('The database was not initialized from the current schema.prisma.')
    if (!sameSchema(await describe(client), JSON.parse(String(state.structure))))
      throw new Error('The database structure changed outside the development schema workflow.')
  } catch (error) {
    throw new Error(
      'Database is not ready. For disposable development data run npm run db:reset explicitly. ' +
        error.message,
      { cause: error }
    )
  }
}

async function initializeDatabase(client, { reset = false, schemaPath = SCHEMA_FILE } = {}) {
  const reference = await buildReference(schemaPath)
  let transaction
  try {
    transaction = await client.transaction('write')
    const current = await transaction.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    if (!reset && current.rows.length) {
      await checkDatabaseSchema(transaction, schemaPath)
      await transaction.commit()
      return { created: false }
    }
    if (reset) {
      // Explicit development reset only. Unknown tables are never silently deleted.
      for (const table of [...APPLICATION_TABLES, STATE_TABLE, LEGACY_LEDGER])
        await transaction.execute(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`)
    }
    await transaction.executeMultiple(reference.sql)
    if (!sameSchema(await describe(transaction), reference.schema))
      throw new Error('The generated development schema differs from schema.prisma.')
    if ((await transaction.execute('PRAGMA foreign_key_check')).rows.length)
      throw new Error('The development schema contains foreign-key violations.')
    const integrity = await transaction.execute('PRAGMA integrity_check')
    if (integrity.rows.length !== 1 || integrity.rows[0][0] !== 'ok')
      throw new Error('The development schema failed integrity_check.')
    await transaction.execute(
      `CREATE TABLE "${STATE_TABLE}" ("id" INTEGER NOT NULL PRIMARY KEY CHECK (id=1), "fingerprint" TEXT NOT NULL, "structure" TEXT NOT NULL)`
    )
    await transaction.execute({
      sql: `INSERT INTO "${STATE_TABLE}" (id, fingerprint, structure) VALUES (1, ?, ?)`,
      args: [reference.fingerprint, JSON.stringify(reference.schema)]
    })
    await transaction.commit()
    return { created: true }
  } catch (error) {
    await transaction?.rollback()
    throw error
  } finally {
    transaction?.close()
    reference.client.close()
  }
}

module.exports = {
  schemaFingerprint,
  generateSchemaSql,
  describe,
  sameSchema,
  buildReference,
  checkDatabaseSchema,
  initializeDatabase
}
