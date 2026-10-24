import type { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { fromCents } from './money'

export class FinanceError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message)
  }
}
export async function mainAccount(userId: number, db: Prisma.TransactionClient = prisma) {
  const existing = await db.account.findUnique({ where: { id: `main-${userId}` } })
  if (existing) return existing
  return db.account.upsert({
    where: { id: `main-${userId}` },
    create: { id: `main-${userId}`, userId, name: 'Main', isMain: true },
    update: {}
  })
}
export async function movementAccount(
  userId: number,
  id: unknown,
  db: Prisma.TransactionClient = prisma
) {
  const account =
    id === undefined || id === null
      ? await mainAccount(userId, db)
      : await db.account.findFirst({ where: { id: String(id), userId, archived: false } })
  if (!account || account.archived || account.isGoal)
    throw new FinanceError('Choose an active account.')
  return account
}
export async function balance(userId: number, id: string, db: Prisma.TransactionClient = prisma) {
  const account = await db.account.findFirst({ where: { id, userId } })
  if (!account) throw new FinanceError('Account not found.', 404)
  const where = {
    userId,
    ...(account.isMain ? { OR: [{ accountId: id }, { accountId: null }] } : { accountId: id })
  }
  const [income, expense, incoming, outgoing] = await Promise.all([
    db.transaction.aggregate({ where: { ...where, type: 'Income' }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { ...where, type: 'Expense' }, _sum: { amount: true } }),
    db.transfer.aggregate({ where: { userId, destinationId: id }, _sum: { amount: true } }),
    db.transfer.aggregate({ where: { userId, sourceId: id }, _sum: { amount: true } })
  ])
  return (
    account.openingBalance +
    (income._sum.amount || 0) -
    (expense._sum.amount || 0) +
    (incoming._sum.amount || 0) -
    (outgoing._sum.amount || 0)
  )
}
/** Optional owned account scope, including legacy movements belonging to Main. */
export async function accountTransactionScope(userId: number, accountId: unknown) {
  if (accountId === undefined)
    return { account: null, where: { userId } as Prisma.TransactionWhereInput }
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(accountId))
    throw new FinanceError('Invalid account ID.')
  const account = await prisma.account.findFirst({
    where: { id: accountId, userId, archived: false, isGoal: false }
  })
  if (!account) throw new FinanceError('Choose an active account.', 404)
  const where: Prisma.TransactionWhereInput = {
    userId,
    ...(account.isMain ? { OR: [{ accountId }, { accountId: null }] } : { accountId })
  }
  return { account, where }
}
/** Run inside the same write transaction as the mutation; failure rolls everything back. */
export async function requireFunds(
  userId: number,
  ids: (string | null | undefined)[],
  db: Prisma.TransactionClient
) {
  for (const id of new Set(ids)) {
    const actual = id ?? (await mainAccount(userId, db)).id
    const funds = await balance(userId, actual, db)
    const account = await db.account.findUnique({ where: { id: actual } })
    if (account?.archived && funds !== 0)
      throw new FinanceError('Restore the archived account before changing its balance.', 409)
    if (funds < 0)
      throw new FinanceError(
        'Insufficient funds. This change would leave an account with a negative balance.',
        409
      )
  }
}
export async function accountList(userId: number, db: Prisma.TransactionClient = prisma) {
  await mainAccount(userId, db)
  // SQLite rowid preserves insertion order even though account IDs are UUIDs.
  // Read IDs only so Prisma continues decoding booleans and amounts normally.
  const insertionOrder = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM Account WHERE userId = ${userId} ORDER BY rowid ASC
  `
  const positions = new Map(insertionOrder.map((row, index) => [row.id, index]))
  const accounts = await db.account.findMany({ where: { userId } })
  accounts.sort(
    (a, b) =>
      Number(a.isGoal) - Number(b.isGoal) ||
      Number(b.isMain) - Number(a.isMain) ||
      positions.get(a.id)! - positions.get(b.id)!
  )
  return Promise.all(
    accounts.map(async account => ({
      ...account,
      targetAmount: account.targetAmount === null ? null : fromCents(account.targetAmount),
      openingBalance: fromCents(account.openingBalance),
      balance: fromCents(await balance(userId, account.id, db))
    }))
  )
}
export async function financialWrite<T>(
  userId: number,
  key: string | null,
  task: (db: Prisma.TransactionClient) => Promise<T>,
  replay?: (db: Prisma.TransactionClient, original: T) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async db => {
    if (key) {
      const receipt = await db.financialReceipt.findUnique({
        where: { userId_key: { userId, key } }
      })
      if (receipt) {
        const original = JSON.parse(receipt.response) as T
        return replay ? replay(db, original) : original
      }
    }
    const result = await task(db)
    if (key && !(result && typeof result === 'object' && 'error' in result))
      await db.financialReceipt.create({ data: { userId, key, response: JSON.stringify(result) } })
    return result
  })
}
