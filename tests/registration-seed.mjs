// Test-only bootstrap: closes its SQLite handles by exiting the child process.
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'
import { createClient } from '@libsql/client'

const raw = createClient({ url: `file:${process.argv[2].replace(/\\/g, '/')}` })
const db = new PrismaClient({ adapter: new PrismaLibSQL(raw) })
await db.user.create({
  data: { name: 'Owner', email: 'owner@example.com', password: await bcrypt.hash('secret1', 10) }
})
await db.$disconnect()
raw.close()
