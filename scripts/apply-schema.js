// Applies the Prisma schema to the configured database.
//
// Why this exists: `prisma db push` cannot be used here. The Prisma CLI reads
// the datasource URL directly and its SQLite connector only accepts `file:`,
// so it rejects a hosted `libsql://` URL (Turso) with
// "the URL must start with the protocol file:". The CLI does not go through the
// driver adapter, so the adapter that the app itself uses makes no difference
// here.
//
// What this does instead:
//   1. Asks Prisma to diff the schema against an empty database. That step is
//      pure codegen: it needs no connection and always reflects the current
//      schema.prisma, so the SQL can never drift from the models.
//   2. Runs that SQL through @libsql/client, which does speak libsql://.
//
// It brings the database up to the schema, additively: missing tables,
// indexes and columns are created, and nothing is ever dropped. Safe to run on
// every deploy; an already-synced database is a no-op.
const { createClient } = require('@libsql/client')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

// Loads the local .env for development. On Render the variables come from the
// service's environment and dotenv leaves them untouched.
require('dotenv').config()

const BACKEND_DIR = path.resolve(__dirname, '..')
const SCHEMA = path.join('prisma', 'schema.prisma')

/** Asks Prisma for the CREATE statements that turn an empty DB into the schema. */
function generateDdl() {
  const result = spawnSync(
    'npx',
    ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', SCHEMA, '--script'],
    { cwd: BACKEND_DIR, encoding: 'utf8', shell: true }
  )

  if (result.status !== 0) {
    throw new Error(`prisma migrate diff failed:\n${result.stderr || result.stdout}`)
  }
  return result.stdout
}

/**
 * Splits the script into individual statements.
 * The DDL Prisma emits has no semicolons inside string literals, so splitting
 * on them is safe here, but the comment lines are dropped first.
 */
function toStatements(ddl) {
  return ddl
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * The object a statement creates, so it can be checked before running:
 *   CREATE TABLE "User"                -> table User
 *   CREATE UNIQUE INDEX "User_email_key" -> index User_email_key
 * Returns null for anything else, which then just runs.
 */
function objectOf(statement) {
  const table = statement.match(/CREATE TABLE "([^"]+)"/)
  if (table) return { type: 'table', name: table[1] }

  const index = statement.match(/CREATE (?:UNIQUE )?INDEX "([^"]+)"/)
  if (index) return { type: 'index', name: index[1] }

  return null
}

async function exists(client, type, name) {
  const res = await client.execute(
    'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
    [type, name]
  )
  return res.rows.length > 0
}

async function columnsOf(client, table) {
  const res = await client.execute(`PRAGMA table_info("${table}")`)
  return res.rows.map(r => r.name)
}

/**
 * The column definitions inside a CREATE TABLE statement, one per entry.
 * Prisma emits exactly one field per line, which is what this relies on.
 */
function parseColumns(createStatement) {
  return createStatement
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('"') && line.includes('" '))
    .map(line => {
      const match = line.match(/^"([^"]+)"\s+(.*)$/)
      return match ? { name: match[1], definition: line } : null
    })
    .filter(Boolean)
}

/**
 * The same definition minus the constraints SQLite refuses in ADD COLUMN, and
 * minus the trailing comma that separates fields in the generated script.
 *
 * A @unique field becomes a separate CREATE UNIQUE INDEX, so the inline
 * keywords left to strip are the primary key ones.
 */
function addColumnDefinition(definition) {
  return definition
    .replace(/,$/, '')
    .replace(/\s+PRIMARY\s+KEY/gi, '')
    .replace(/\s+AUTOINCREMENT/gi, '')
    .replace(/\s+UNIQUE/gi, '')
    .trim()
}

/**
 * Adds the columns a table is missing.
 *
 * Without this, a table that already exists is skipped whole, so adding a
 * field to a model looks like it applied and then fails at runtime with
 * "no such column". Columns present in the database but absent from the schema
 * are only reported: dropping data is never this script's decision.
 */
async function alignColumns(client, table, createStatement) {
  const desired = parseColumns(createStatement)
  const live = await columnsOf(client, table)
  const missing = desired.filter(c => !live.includes(c.name))
  const extra = live.filter(name => !desired.some(c => c.name === name))

  for (const name of extra) {
    console.log(`  ! ${table}.${name} is in the database but not in the schema (left alone)`)
  }

  for (const column of missing) {
    const definition = addColumnDefinition(column.definition)
    try {
      await client.execute(`ALTER TABLE "${table}" ADD COLUMN ${definition}`)
      console.log(`  + ${table}.${column.name}`)
    } catch (err) {
      throw new Error(
        `Could not add the column ${table}.${column.name}.\n` +
          `  statement: ALTER TABLE "${table}" ADD COLUMN ${definition}\n` +
          `  reason:    ${err.message}\n` +
          `  SQLite refuses to add a NOT NULL column with no default to a table that ` +
          `already has rows, and it cannot drop or rename columns. If that is the ` +
          `cause, the data has to be recreated: this script never drops anything.`,
        { cause: err }
      )
    }
  }
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. Nothing to apply.')
    process.exit(1)
  }

  const authToken = process.env.TURSO_AUTH_TOKEN || undefined
  const client = createClient(authToken ? { url, authToken } : { url })

  const statements = toStatements(generateDdl())
  let created = 0
  let skipped = 0

  for (const statement of statements) {
    // Tables and indexes are checked separately, so a half-applied database
    // (tables there, indexes missing) still finishes the job.
    const object = objectOf(statement)
    if (object && (await exists(client, object.type, object.name))) {
      if (object.type === 'table') {
        await alignColumns(client, object.name, statement)
      } else {
        console.log(`  = ${object.name} already exists`)
      }
      skipped += 1
      continue
    }

    await client.execute(statement)
    created += 1
    const label = object ? object.name : statement.split('\n')[0].slice(0, 60)
    console.log(`  + ${label}`)
  }

  console.log(`Schema applied: ${created} created, ${skipped} already present.`)
}

main().catch(err => {
  console.error('Failed to apply the schema:', err.message || err)
  process.exit(1)
})
