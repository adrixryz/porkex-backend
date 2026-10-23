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
    db.transaction.aggregate({ where: { ...where, type: 'INCOME' }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { ...where, type: 'EXPENSE' }, _sum: { amount: true } }),
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
/** Run inside the same write transaction as the mutation; failure rolls everything back. */
export async function requireFunds(
  userId: number,
  ids: (string | null | undefined)[],
  db: Prisma.TransactionClient
) {
  for (const id of new Set(ids)) {
    const actual = id ?? (await mainAccount(userId, db)).id
    if ((await balance(userId, actual, db)) < 0)
      throw new FinanceError(
        'Insufficient funds. This change would leave an account with a negative balance.',
        409
      )
  }
}
export async function accountList(userId: number, db: Prisma.TransactionClient = prisma) {
  await mainAccount(userId, db)
  const accounts = await db.account.findMany({
    where: { userId },
    orderBy: [{ isMain: 'desc' }, { name: 'asc' }]
  })
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
