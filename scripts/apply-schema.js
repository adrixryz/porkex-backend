// Initialize the current disposable development schema on SQLite or Turso.
const { loadEnvironment, databaseConfig, createClient, safeError } = require('./lib/database')
const { buildReference, initializeDatabase } = require('./lib/schema')
const { referenceVersions } = require('./lib/migrations')

loadEnvironment()

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length && args[0] !== '--check')) {
    throw new Error('Usage: npm run db:apply -- [--check]')
  }
  if (args[0] === '--check') {
    const reference = await buildReference()
    reference.client.close()
    await referenceVersions()
    console.log('The current development schema can be generated from schema.prisma.')
    return
  }
  const client = createClient(databaseConfig({ mustExist: false }))
  try {
    const result = await initializeDatabase(client)
    console.log(
      result.created
        ? 'Development schema initialized from schema.prisma.'
        : 'Development schema is already current; data was preserved.'
    )
  } finally {
    client.close()
  }
}

main().catch(error => {
  console.error(safeError(error))
  process.exitCode = 1
})
