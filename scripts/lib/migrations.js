const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { BACKEND_DIR, createClient, quoteIdentifier } = require('./database')

const LEDGER = '_PorkexMigration'
const LEDGER_SQL = `CREATE TABLE "${LEDGER}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "checksum" TEXT NOT NULL,
  "appliedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`

function loadMigrations(directory = path.join(BACKEND_DIR, 'prisma', 'migrations')) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      if (!/^\d{3}_[a-z0-9_]+$/.test(entry.name))
        throw new Error(`Invalid migration directory: ${entry.name}`)
      const sql = fs.readFileSync(path.join(directory, entry.name, 'migration.sql'), 'utf8')
      return {
        id: entry.name,
        sql,
        checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

function canonicalDefault(value) {
  if (value === null) return null
  const text = String(value)
    .trim()
    .replace(/^\((.*)\)$/, '$1')
  return text.startsWith("'") ? text : text.toUpperCase()
}

async function describe(client, { includeLedger = false } = {}) {
  const catalog = (
    await client.execute(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
  ).rows.filter(row => includeLedger || (row.name !== LEDGER && row.tbl_name !== LEDGER))
  const objects = catalog.filter(row => row.type !== 'table' && row.type !== 'index')
  if (objects.length) throw new Error(`Unexpected schema object: ${objects[0].name}`)
  const tables = catalog.filter(row => row.type === 'table')
  const statements = tables.flatMap(table => [
    `PRAGMA table_xinfo(${quoteIdentifier(table.name)})`,
    `PRAGMA foreign_key_list(${quoteIdentifier(table.name)})`
  ])
  const results = statements.length ? await client.batch(statements) : []
  const described = []
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i]
    const columns = results[i * 2].rows
      .map(row => ({
        name: row.name,
        type: row.type.toUpperCase(),
        notnull: Number(row.notnull),
        default: canonicalDefault(row.dflt_value),
        pk: Number(row.pk),
        hidden: Number(row.hidden)
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const foreignKeys = results[i * 2 + 1].rows
      .map(row => ({
        table: row.table,
        from: row.from,
        to: row.to,
        onUpdate: row.on_update,
        onDelete: row.on_delete,
        match: row.match
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    // Explicit SQL captures expressions, partial predicates, sort order and uniqueness.
    const indexes = catalog
      .filter(row => row.type === 'index' && row.tbl_name === table.name)
      .map(row => ({ name: row.name, sql: normalizeSql(row.sql) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const normalized = normalizeSql(table.sql)
    described.push({
      name: table.name,
      columns,
      foreignKeys,
      indexes,
      autoincrement: /\bAUTOINCREMENT\b/i.test(table.sql),
      withoutRowid: /\bWITHOUT ROWID\b/i.test(table.sql),
      strict: /\)\s*STRICT\s*$/i.test(table.sql),
      // Current Prisma models have no CHECK constraints or generated expressions.
      unsupported:
        /\bCHECK\s*\(|\bGENERATED\b|\bCOLLATE\b|\bUNIQUE\b|\bDEFERRABLE\b|\bON CONFLICT\b/i.test(
          normalized
        )
    })
  }
  return described.sort((a, b) => a.name.localeCompare(b.name))
}

function normalizeSql(sql) {
  return sql?.replace(/\s+/g, ' ').trim().replace(/;$/, '') || null
}

function sameSchema(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function buildReference(migrations) {
  const client = createClient({ url: 'file::memory:', intMode: 'bigint' })
  try {
    const versions = []
    for (const migration of migrations) {
      await client.executeMultiple(migration.sql)
      versions.push(await describe(client))
    }
    return { client, versions }
  } catch (error) {
    client.close()
    throw error
  }
}

async function checkPrismaSchema(
  expected,
  schemaPath = path.join(BACKEND_DIR, 'prisma', 'schema.prisma')
) {
  const result = spawnSync(
    process.execPath,
    [
      require.resolve('prisma/build/index.js'),
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
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
      `Could not inspect Prisma schema: ${result.error?.message || result.stderr || result.stdout}`
    )
  const target = createClient({ url: 'file::memory:', intMode: 'bigint' })
  try {
    await target.executeMultiple(result.stdout)
    if (!sameSchema(await describe(target), expected))
      throw new Error(
        'Prisma schema differs from versioned migrations. Add a migration before applying it.'
      )
  } finally {
    target.close()
  }
}

function isKnownLegacy(live, expected) {
  const canonical = JSON.parse(JSON.stringify(expected))
  const transactions = canonical.find(table => table.name === 'Transaction')
  transactions.foreignKeys = transactions.foreignKeys.filter(key => key.from !== 'recurringId')
  return sameSchema(live, canonical)
}

async function normalizeLegacy(transaction, baselineSql) {
  const reference = createClient({ url: 'file::memory:', intMode: 'bigint' })
  try {
    await reference.executeMultiple(baselineSql)
    const ddl = (
      await reference.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='Transaction'"
      )
    ).rows[0].sql
    const indexes = (
      await reference.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='Transaction' AND sql IS NOT NULL ORDER BY name"
      )
    ).rows
    const sequence = (
      await transaction.execute("SELECT seq FROM sqlite_sequence WHERE name='Transaction'")
    ).rows[0]?.seq
    await transaction.execute(
      'CREATE TABLE "_PorkexLegacyTransaction" AS SELECT * FROM "Transaction"'
    )
    await transaction.execute('DROP TABLE "Transaction"')
    await transaction.execute(ddl)
    // SQL-to-SQL copy preserves all original storage classes, bytes and IDs.
    const columns = (await reference.execute('PRAGMA table_info("Transaction")')).rows
      .map(row => quoteIdentifier(row.name))
      .join(', ')
    await transaction.execute(
      `INSERT INTO "Transaction" (${columns}) SELECT ${columns} FROM "_PorkexLegacyTransaction"`
    )
    for (const index of indexes) await transaction.execute(index.sql)
    if (sequence !== undefined)
      await transaction.execute({
        sql: "UPDATE sqlite_sequence SET seq=? WHERE name='Transaction'",
        args: [sequence]
      })
    await transaction.execute('DROP TABLE "_PorkexLegacyTransaction"')
  } finally {
    reference.close()
  }
}

function historicalBaseline(checksum) {
  if (!/^[a-f0-9]{64}$/.test(checksum)) return null
  const file = path.join(BACKEND_DIR, 'prisma', 'historical-baselines', `${checksum}.sql`)
  if (!fs.existsSync(file)) return null
  const sql = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  if (createHash('sha256').update(sql).digest('hex') !== checksum)
    throw new Error('Historical baseline checksum mismatch.')
  return { id: '001_baseline', sql, checksum }
}

/** Upgrade only a schema already verified against a shipped historical baseline.
 * Copy every table before rebuilding, preserving raw values and AUTOINCREMENT cursors.
 * The caller owns the write transaction, including its original migration ledger.
 */
async function upgradeHistoricalSchema(transaction, targetMigrations) {
  const reference = await buildReference(targetMigrations)
  try {
    const tables = await describe(transaction)
    const target = await describe(reference.client)
    const sequences = (await transaction.execute('SELECT name, seq FROM sqlite_sequence')).rows
    const ordered = []
    const visit = table => {
      if (ordered.includes(table.name)) return
      for (const fk of table.foreignKeys) {
        const parent = tables.find(candidate => candidate.name === fk.table)
        if (parent) visit(parent)
      }
      ordered.push(table.name)
    }
    tables.forEach(visit)
    for (const table of tables)
      await transaction.execute(
        `CREATE TABLE "_PorkexUpgrade_${table.name}" AS SELECT * FROM ${quoteIdentifier(table.name)} ORDER BY rowid`
      )
    for (const name of [...ordered].reverse())
      await transaction.execute(`DROP TABLE ${quoteIdentifier(name)}`)
    const ddl = (
      await reference.client.execute(
        "SELECT type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
      )
    ).rows
    for (const row of ddl) await transaction.execute(row.sql)
    await transaction.execute('PRAGMA defer_foreign_keys=ON')
    for (const table of tables) {
      const columns = table.columns
        .filter(column =>
          target
            .find(row => row.name === table.name)
            ?.columns.some(next => next.name === column.name)
        )
        .map(column => quoteIdentifier(column.name))
        .join(', ')
      await transaction.execute(
        `INSERT INTO ${quoteIdentifier(table.name)} (${columns}) SELECT ${columns} FROM "_PorkexUpgrade_${table.name}" ORDER BY rowid`
      )
      await transaction.execute(`DROP TABLE "_PorkexUpgrade_${table.name}"`)
    }
    for (const row of sequences) {
      await transaction.execute({
        sql: 'UPDATE sqlite_sequence SET seq=? WHERE name=?',
        args: [row.seq, row.name]
      })
      await transaction.execute({
        sql: 'INSERT INTO sqlite_sequence (name, seq) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name=?)',
        args: [row.name, row.seq, row.name]
      })
    }
  } finally {
    reference.client.close()
  }
}

async function checkDatabaseSchema(client, migrations = loadMigrations()) {
  const reference = await buildReference(migrations)
  try {
    const applied = (
      await client.execute('SELECT id, checksum FROM "_PorkexMigration" ORDER BY id')
    ).rows
    if (applied.length !== migrations.length) throw new Error('Pending database migrations.')
    for (let i = 0; i < migrations.length; i++)
      if (
        applied[i].id !== migrations[i].id ||
        (applied[i].checksum !== migrations[i].checksum &&
          !(i === 0 && historicalBaseline(applied[i].checksum)))
      )
        throw new Error('Migration history or checksum mismatch.')
    if (!sameSchema(await describe(client), reference.versions.at(-1)))
      throw new Error('Database schema drift detected.')
  } catch (error) {
    throw new Error(
      `Database is not ready. Apply reviewed migrations with npm run db:apply before starting. ${error.message}`,
      { cause: error }
    )
  } finally {
    reference.client.close()
  }
}

async function runMigrations(client, migrations) {
  if (!migrations.length) throw new Error('No versioned migrations found.')
  const reference = await buildReference(migrations)
  const transaction = await client.transaction('write')
  try {
    const hasLedger =
      (
        await transaction.execute({
          sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          args: [LEDGER]
        })
      ).rows.length > 0
    const live = await describe(transaction)
    let applied = []
    let historical = null
    if (hasLedger) {
      const ledgerReference = createClient({ url: 'file::memory:', intMode: 'bigint' })
      try {
        await ledgerReference.execute(LEDGER_SQL)
        const full = await describe(transaction, { includeLedger: true })
        const actualLedger = full.filter(table => table.name === LEDGER)
        if (!sameSchema(actualLedger, await describe(ledgerReference, { includeLedger: true })))
          throw new Error('Migration ledger schema has drifted.')
      } finally {
        ledgerReference.close()
      }
      applied = (await transaction.execute(`SELECT id, checksum FROM "${LEDGER}" ORDER BY id`)).rows
      historical =
        applied[0]?.checksum !== migrations[0].checksum
          ? historicalBaseline(applied[0]?.checksum || '')
          : null
      for (let i = 0; i < applied.length; i++) {
        if (
          applied[i].id !== migrations[i]?.id ||
          (applied[i].checksum !== migrations[i]?.checksum && !(i === 0 && historical))
        )
          throw new Error(
            'Migration history or checksum mismatch. Applied migrations must remain unchanged.'
          )
      }
      let expected = applied.length ? reference.versions[applied.length - 1] : []
      if (historical && applied.length <= 7) {
        const previous = await buildReference([historical, ...migrations.slice(1, applied.length)])
        expected = previous.versions.at(-1)
        previous.client.close()
      }
      if (!sameSchema(live, expected))
        throw new Error('Database schema drift detected; nothing was applied.')
    } else if (live.length) {
      const baseline = reference.versions[0]
      if (!sameSchema(live, baseline)) {
        if (isKnownLegacy(live, baseline)) await normalizeLegacy(transaction, migrations[0].sql)
        else {
          for (const file of fs.readdirSync(
            path.join(BACKEND_DIR, 'prisma', 'historical-baselines')
          )) {
            const candidate = historicalBaseline(file.replace('.sql', ''))
            const previous = await buildReference([candidate])
            try {
              if (
                sameSchema(live, previous.versions[0]) ||
                isKnownLegacy(live, previous.versions[0])
              ) {
                historical = candidate
                if (!sameSchema(live, previous.versions[0]))
                  await normalizeLegacy(transaction, candidate.sql)
                break
              }
            } finally {
              previous.client.close()
            }
          }
          if (!historical)
            throw new Error('Unknown existing schema; baseline adoption refused without changes.')
        }
      }
      applied = [historical ?? migrations[0]]
    }
    if (!hasLedger) {
      await transaction.execute(LEDGER_SQL)
      for (const migration of applied)
        await transaction.execute({
          sql: `INSERT INTO "${LEDGER}" (id, checksum) VALUES (?, ?)`,
          args: [migration.id, migration.checksum]
        })
    }
    let count = 0
    for (const migration of migrations.slice(applied.length)) {
      if (migration.id === '008_finance_recovery' && historical)
        await upgradeHistoricalSchema(transaction, migrations.slice(0, 7))
      await transaction.executeMultiple(migration.sql)
      await transaction.execute({
        sql: `INSERT INTO "${LEDGER}" (id, checksum) VALUES (?, ?)`,
        args: [migration.id, migration.checksum]
      })
      count++
    }
    if (!sameSchema(await describe(transaction), reference.versions.at(-1)))
      throw new Error('Migration result differs from the expected schema.')
    if ((await transaction.execute('PRAGMA foreign_key_check')).rows.length)
      throw new Error('Migration would leave foreign-key violations; all changes were rolled back.')
    const integrity = await transaction.execute('PRAGMA integrity_check')
    if (integrity.rows.length !== 1 || integrity.rows[0][0] !== 'ok')
      throw new Error('Migration integrity check failed; all changes were rolled back.')
    await transaction.commit()
    return { applied: count, total: migrations.length }
  } finally {
    transaction.close()
    reference.client.close()
  }
}

module.exports = {
  loadMigrations,
  describe,
  sameSchema,
  buildReference,
  checkPrismaSchema,
  runMigrations,
  checkDatabaseSchema,
  historicalBaseline
}
