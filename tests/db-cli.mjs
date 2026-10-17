// Out-of-process helper for the recurring suite: it reaches into the throwaway
// database without holding its file open afterwards. libSQL keeps the SQLite
// handle locked on Windows until the process exits (close() is not enough), so
// every touch runs as a short-lived child; the OS does the releasing.
//
// Usage:
//   node tests/db-cli.mjs age <dbUrl> <ruleId> <YYYY-MM-DD>
//     Moves a rule's nextDate to that day (aging it, or pretending a catch-up
//     never ran).
//   node tests/db-cli.mjs count-tx <dbUrl> <ruleId>
//     Prints how many movements the rule has generated, without triggering the
//     API's catch-up (which any HTTP call would).
import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'
import { createClient } from '@libsql/client'

const [, , command, url, id, extra] = process.argv

if (!command || !url || !id) {
  console.error('Usage: node tests/db-cli.mjs <age|count-tx> <dbUrl> <ruleId> [YYYY-MM-DD]')
  process.exit(2)
}

const raw = createClient({ url })
const db = new PrismaClient({ adapter: new PrismaLibSQL(raw) })

if (command === 'age') {
  const [y, m, d] = (extra ?? '').split('-').map(Number)
  if (!y || !m || !d) {
    console.error('age needs a YYYY-MM-DD date')
    process.exit(2)
  }
  await db.recurringRule.update({
    where: { id: Number(id) },
    data: { nextDate: new Date(Date.UTC(y, m - 1, d)), lastProcessedDate: null }
  })
} else if (command === 'count-tx') {
  const count = await db.transaction.count({ where: { recurringId: Number(id) } })
  process.stdout.write(String(count))
} else if (command === 'frequency') {
  await db.recurringRule.update({ where: { id: Number(id) }, data: { frequency: extra } })
} else {
  console.error(`Unknown command: ${command}`)
  process.exit(2)
}

await db.$disconnect()
raw.close()
