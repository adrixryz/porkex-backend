import type { Client } from '@libsql/client'

export function checkDatabaseSchema(client: Client): Promise<void>
