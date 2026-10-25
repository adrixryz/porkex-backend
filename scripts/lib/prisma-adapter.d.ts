import type { Client } from '@libsql/client'
import type { PrismaLibSql } from '@prisma/adapter-libsql'
export function createPrismaAdapter(client: Client): PrismaLibSql
