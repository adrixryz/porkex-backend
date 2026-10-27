const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  loadEnvironment,
  databaseConfig,
  createClient,
  safeError,
  BACKEND_DIR
} = require('./lib/database')
const { migrateDatabase } = require('./lib/migrations')

loadEnvironment()

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--backup' || !args[1])
    throw new Error('Usage: npm run db:migrate -- --backup path/to/new-backup.db')
  const backup = path.resolve(BACKEND_DIR, args[1])
  for (const [script, scriptArgs] of [
    ['backup-db.js', ['--output', backup]],
    ['verify-backup.js', [backup]]
  ]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, script), ...scriptArgs], {
      cwd: BACKEND_DIR,
      env: process.env,
      encoding: 'utf8'
    })
    if (result.error || result.status !== 0)
      throw new Error(
        result.error?.message || result.stderr.trim() || 'Backup verification failed.'
      )
    process.stdout.write(result.stdout)
  }
  const client = createClient(databaseConfig())
  try {
    const result = await migrateDatabase(client)
    console.log(`Applied ${result.applied} migrations; ${result.total} total.`)
  } finally {
    client.close()
  }
}

main().catch(error => {
  console.error(safeError(error))
  process.exitCode = 1
})
