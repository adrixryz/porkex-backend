// The child releases native libSQL handles before the final file is published.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { BACKEND_DIR, loadEnvironment, safeError } = require('./lib/database')

loadEnvironment()

function main() {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--output')) {
    throw new Error('Usage: npm run db:backup -- [--output path.db]')
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.resolve(
    BACKEND_DIR,
    args[1] || path.join('prisma', 'backups', `${stamp}-${randomUUID()}.db`)
  )
  if (fs.existsSync(target)) throw new Error('The backup destination already exists.')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const partial = `${target}.${randomUUID()}.partial.db`
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'backup-worker.js'), 'copy', partial],
      {
        cwd: BACKEND_DIR,
        env: process.env,
        encoding: 'utf8'
      }
    )
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message || result.stderr.trim() || 'Backup worker failed.')
    }
    // Exclusive publication cannot overwrite another backup at the same path.
    fs.linkSync(partial, target)
    fs.unlinkSync(partial)
    console.log(`Verified backup created: ${target}`)
  } finally {
    for (const suffix of ['', '-journal', '-wal', '-shm'])
      fs.rmSync(partial + suffix, { force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(safeError(error))
  process.exitCode = 1
}
