// Apply reviewed, checksummed migrations to local SQLite or hosted Turso.
const { loadEnvironment, databaseConfig, createClient, safeError } = require('./lib/database')
const {
  loadMigrations,
  buildReference,
  checkPrismaSchema,
  runMigrations
} = require('./lib/migrations')

loadEnvironment()

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length && args[0] !== '--check')) {
    throw new Error('Usage: npm run db:apply -- [--check]')
  }
  const migrations = loadMigrations()
  const reference = await buildReference(migrations)
  try {
    await checkPrismaSchema(reference.versions.at(-1))
  } finally {
    reference.client.close()
  }
  if (args[0] === '--check') {
    console.log('Prisma schema and versioned migrations agree.')
    return
  }
  const client = createClient(databaseConfig({ mustExist: false }))
  try {
    const result = await runMigrations(client, migrations)
    console.log('Migrations applied: ' + result.applied + ' new, ' + result.total + ' total.')
  } finally {
    client.close()
  }
}

main().catch(error => {
  console.error(safeError(error))
  process.exitCode = 1
})
