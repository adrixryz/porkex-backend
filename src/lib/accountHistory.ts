import { Prisma } from '@prisma/client'
import type { BalanceAdjustment } from '@prisma/client'
import { fromCents } from './money'

export const serializeAdjustment = (entry: BalanceAdjustment) => ({
  ...entry,
  previousBalance: fromCents(entry.previousBalance),
  balance: fromCents(entry.balance),
  date: entry.effectiveDate.toISOString()
})

/** Select only the requested page before hydrating its account relations. */
export async function accountHistory(
  db: Prisma.TransactionClient,
  userId: number,
  accountId: string | undefined,
  requestedPage: unknown,
  includeTransfers: boolean
) {
  const adjustmentScope = accountId ? Prisma.sql`AND accountId = ${accountId}` : Prisma.empty
  const transferScope = accountId
    ? Prisma.sql`AND (sourceId = ${accountId} OR destinationId = ${accountId})`
    : Prisma.empty
  const transferRows = includeTransfers
    ? Prisma.sql`UNION ALL SELECT id, 'transfer' AS kind, date AS effectiveDate, createdAt FROM Transfer WHERE userId = ${userId} ${transferScope}`
    : Prisma.empty
  const rows = Prisma.sql`SELECT id, kind, effectiveDate, createdAt FROM BalanceAdjustment WHERE userId = ${userId} ${adjustmentScope} ${transferRows}`
  const [count] = await db.$queryRaw<{ total: bigint }[]>(
    Prisma.sql`SELECT count(*) AS total FROM (${rows})`
  )
  const total = Number(count!.total)
  const totalPages = Math.max(1, Math.ceil(total / 15))
  const page = Math.min(totalPages, Math.max(1, Math.floor(Number(requestedPage) || 1)))
  const selected = await db.$queryRaw<{ id: string; kind: string }[]>(Prisma.sql`
    SELECT id, kind FROM (${rows})
    ORDER BY CASE WHEN typeof(effectiveDate) IN ('integer', 'real') THEN effectiveDate
      ELSE CAST(ROUND((julianday(effectiveDate) - 2440587.5) * 86400000) AS INTEGER) END DESC,
      CASE WHEN typeof(createdAt) IN ('integer', 'real') THEN createdAt
      ELSE CAST(ROUND((julianday(createdAt) - 2440587.5) * 86400000) AS INTEGER) END DESC, id DESC
    LIMIT 15 OFFSET ${(page - 1) * 15}`)
  const [adjustments, transfers] = await Promise.all([
    db.balanceAdjustment.findMany({
      where: {
        userId,
        id: { in: selected.filter(row => row.kind !== 'transfer').map(row => row.id) }
      }
    }),
    db.transfer.findMany({
      where: {
        userId,
        id: { in: selected.filter(row => row.kind === 'transfer').map(row => row.id) }
      },
      include: { source: true, destination: true }
    })
  ])
  const entries = new Map<string, unknown>([
    ...adjustments.map(row => [row.id, serializeAdjustment(row)] as const),
    ...transfers.map(
      row => [row.id, { ...row, kind: 'transfer', amount: fromCents(row.amount) }] as const
    )
  ])
  return { items: selected.map(row => entries.get(row.id)), total, page, totalPages }
}
