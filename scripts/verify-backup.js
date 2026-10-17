// Restore into an isolated local copy and read it there; never writes to Turso.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { safeError } = require('./lib/database')

function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-backup.js path.db')
  const source = path.resolve(process.argv[2])
  if (!fs.statSync(source).isFile()) throw new Error('The backup must be a local SQLite file.')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'porkex-restore-'))
  try {
    const restored = path.join(directory, 'restored.db')
    fs.copyFileSync(source, restored)
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'backup-worker.js'), 'verify', restored],
      {
        encoding: 'utf8',
        env: { ...process.env, TURSO_AUTH_TOKEN: '' }
      }
    )
    if (result.error || result.status !== 0)
      throw new Error(
        result.error?.message || result.stderr.trim() || 'Restore verification failed.'
      )
    const counts = JSON.parse(result.stdout)
    if (!counts.tables) throw new Error('The backup contains no application tables.')
    console.log(`Restore verified: ${counts.tables} tables, ${counts.rows} rows.`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(safeError(error))
  process.exitCode = 1
}
