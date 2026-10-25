import { PrismaClient } from '@prisma/client'
import { createPrismaAdapter } from '../../scripts/lib/prisma-adapter'
import { createClient, type Client } from '@libsql/client'

// The database is reached through the libSQL driver adapter, which lets the same
// schema talk to a local file in development and to a hosted Turso database in
// production. Only DATABASE_URL changes between them: @libsql/client opens a
// plain SQLite file when the URL starts with file:, and connects to a remote
// host when it starts with libsql://.
//
// Note the path: @libsql/client resolves a relative file: URL against the
// process working directory, not against the schema folder the Prisma CLI uses.
// That is why DATABASE_URL has to spell out prisma/dev.db rather than dev.db —
// with the shorter form the app silently opened a second, empty database.
//
// TURSO_AUTH_TOKEN is only present for a hosted database. Local files and the
// throwaway databases the tests create do not have one, so it stays optional.
function createDatabaseClient() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and set it to ' +
        'file:./prisma/dev.db for local development, or the libsql:// URL for Turso.'
    )
  }

  const authToken = process.env.TURSO_AUTH_TOKEN
  const client = authToken ? createClient({ url, authToken }) : createClient({ url })
  return client
}

// Singleton: avoids multiple connections in dev (Node watch/ts-node reload modules).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; databaseClient?: Client }

export const databaseClient = globalForPrisma.databaseClient ?? createDatabaseClient()
globalForPrisma.databaseClient = databaseClient
export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter: createPrismaAdapter(databaseClient) })

if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = prisma
}
