const fs = require('node:fs')
const { Buffer } = require('node:buffer')
const { createClient, databaseConfig, quoteIdentifier, safeError } = require('./lib/database')

function canonicalValue(value) {
  if (typeof value === 'bigint') return ['integer', String(value)]
  if (value instanceof ArrayBuffer) return ['blob', Buffer.from(value).toString('hex')]
  return [typeof value, value]
}

function canonicalRows(result) {
  return result.rows
    .map(row => JSON.stringify(result.columns.map((_, i) => canonicalValue(row[i]))))
    .sort()
}

async function checkDatabase(client) {
  const integrity = await client.execute('PRAGMA integrity_check')
  if (integrity.rows.length !== 1 || integrity.rows[0][0] !== 'ok')
    throw new Error('The snapshot failed SQLite integrity_check.')
  if ((await client.execute('PRAGMA foreign_key_check')).rows.length)
    throw new Error('The snapshot contains foreign-key violations.')
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )
  let rows = 0
  for (const table of tables.rows)
    rows += (await client.execute(`SELECT * FROM ${quoteIdentifier(table.name)}`)).rows.length
  return { tables: tables.rows.length, rows }
}

async function copyDatabase(target) {
  fs.closeSync(fs.openSync(target, 'wx'))
  const source = createClient(databaseConfig())
  const destination = createClient({ url: `file:${target.replace(/\\/g, '/')}`, intMode: 'bigint' })
  const snapshot = await source.transaction('read')
  let write
  try {
    const catalog = await snapshot.execute(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    const tables = catalog.rows.filter(row => row.type === 'table')
    if (!tables.length) throw new Error('The configured database contains no tables.')
    await destination.execute('PRAGMA foreign_keys=OFF')
    write = await destination.transaction('write')
    for (const table of tables) await write.execute(table.sql)
    for (const table of tables) {
      const identifier = quoteIdentifier(table.name)
      const info = await snapshot.execute(`PRAGMA table_xinfo(${identifier})`)
      const columns = info.rows.filter(row => Number(row.hidden) === 0).map(row => row.name)
      const names = columns.map(quoteIdentifier).join(', ')
      // Read TEXT as bytes: the native driver otherwise truncates embedded NULs.
      // SQLite is dynamically typed, so preserve each value's storage class.
      const projection = columns
        .map(name => {
          const column = quoteIdentifier(name)
          return `CASE WHEN typeof(${column})='text' THEN CAST(${column} AS BLOB) ELSE ${column} END`
        })
        .concat(columns.map(name => `typeof(${quoteIdentifier(name)})`))
        .join(', ')
      const rows = await snapshot.execute(`SELECT ${projection} FROM ${identifier}`)
      for (const row of rows.rows) {
        await write.execute({
          sql: `INSERT INTO ${identifier} (${names}) VALUES (${columns.map((_, i) => (row[columns.length + i] === 'text' ? 'CAST(? AS TEXT)' : '?')).join(', ')})`,
          args: columns.map((_, i) => row[i])
        })
      }
      const restored = await write.execute(`SELECT ${projection} FROM ${identifier}`)
      if (JSON.stringify(canonicalRows(rows)) !== JSON.stringify(canonicalRows(restored)))
        throw new Error(`Snapshot verification failed for table ${table.name}.`)
    }
    const sequence = await snapshot.execute(
      "SELECT name FROM sqlite_master WHERE name='sqlite_sequence'"
    )
    if (sequence.rows.length) {
      await write.execute('DELETE FROM sqlite_sequence')
      for (const row of (await snapshot.execute('SELECT name, seq FROM sqlite_sequence')).rows) {
        await write.execute({
          sql: 'INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)',
          args: [row.name, row.seq]
        })
      }
    }
    const order = { view: 0, index: 1, trigger: 2 }
    for (const object of catalog.rows
      .filter(row => row.type !== 'table')
      .sort((a, b) => order[a.type] - order[b.type]))
      await write.execute(object.sql)
    await checkDatabase(write)
    await write.commit()
    await snapshot.commit()
  } finally {
    write?.close()
    snapshot.close()
    destination.close()
    source.close()
  }
}

async function main() {
  const [, , operation, file] = process.argv
  if (!file) throw new Error('A local snapshot path is required.')
  if (operation === 'copy') await copyDatabase(file)
  else if (operation === 'verify') {
    const client = createClient({ url: `file:${file.replace(/\\/g, '/')}`, intMode: 'bigint' })
    try {
      console.log(JSON.stringify(await checkDatabase(client)))
    } finally {
      client.close()
    }
  } else throw new Error('Unknown backup operation.')
}

main().catch(error => {
  console.error(safeError(error))
  process.exitCode = 1
})
