import type { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { fromCents } from './money'
import { catalogNameKey } from './catalogNames'

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
/** Total is the sum of included account balances, including cross-account transfers. */
export async function totalBalance(userId: number, db: Prisma.TransactionClient = prisma) {
  const accounts = await db.account.findMany({
    where: { userId, excludeFromTotalBalance: false },
    select: { id: true, isMain: true, openingBalance: true }
  })
  if (!accounts.length) return 0
  const ids = accounts.map(account => account.id)
  const [movements, incoming, outgoing] = await Promise.all([
    db.transaction.groupBy({
      by: ['type'],
      where: {
        userId,
        OR: [
          { accountId: { in: ids } },
          ...(accounts.some(account => account.isMain) ? [{ accountId: null }] : [])
        ]
      },
      _sum: { amount: true }
    }),
    db.transfer.aggregate({
      where: { userId, destinationId: { in: ids } },
      _sum: { amount: true }
    }),
    db.transfer.aggregate({
      where: { userId, sourceId: { in: ids } },
      _sum: { amount: true }
    })
  ])
  return (
    accounts.reduce((sum, account) => sum + account.openingBalance, 0) +
    movements.reduce(
      (sum, group) => sum + (group.type === 'Income' ? 1 : -1) * (group._sum.amount ?? 0),
      0
    ) +
    (incoming._sum.amount ?? 0) -
    (outgoing._sum.amount ?? 0)
  )
}

/** Optional owned account scope, including legacy movements belonging to Main. */
export async function accountTransactionScope(
  userId: number,
  accountId: unknown,
  includeArchived = false
) {
  if (accountId === undefined)
    return { account: null, where: { userId } as Prisma.TransactionWhereInput }
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(accountId))
    throw new FinanceError('Invalid account ID.')
  const account = await prisma.account.findFirst({
    where: {
      id: accountId,
      userId,
      ...(!includeArchived ? { archived: false } : {}),
      isGoal: false
    }
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
  db: Prisma.TransactionClient,
  previousFunds?: ReadonlyMap<string, number>
) {
  for (const id of new Set(ids)) {
    const actual = id ?? (await mainAccount(userId, db)).id
    const funds = await balance(userId, actual, db)
    const account = await db.account.findUnique({ where: { id: actual } })
    if (account?.archived && funds !== 0)
      throw new FinanceError('Restore the archived account before changing its balance.', 409)
    if (funds < 0 && funds < Math.min(0, previousFunds?.get(actual) ?? 0))
      throw new FinanceError(
        'Insufficient funds. This change would leave an account with a negative balance.',
        409
      )
  }
}

/** Capture before writing so imported debt can improve without permitting new debt. */
export async function captureFunds(
  userId: number,
  ids: (string | null | undefined)[],
  db: Prisma.TransactionClient
) {
  const actualIds = new Set<string>()
  for (const id of ids) actualIds.add(id ?? (await mainAccount(userId, db)).id)
  return new Map(
    await Promise.all([...actualIds].map(async id => [id, await balance(userId, id, db)] as const))
  )
}

/** Checked inside the write transaction, with the same case-insensitive policy as categories. */
export async function assertAccountNameAvailable(
  userId: number,
  name: string,
  db: Prisma.TransactionClient,
  exceptId?: string
) {
  const normalized = catalogNameKey(name)
  const accounts = await db.account.findMany({
    where: { userId },
    select: { id: true, name: true }
  })
  if (
    (normalized === 'main' && exceptId !== `main-${userId}`) ||
    accounts.some(account => account.id !== exceptId && catalogNameKey(account.name) === normalized)
  )
    throw new FinanceError('An account with that name already exists.', 409)
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
  const [movements, incoming, outgoing] = await Promise.all([
    db.transaction.groupBy({
      by: ['accountId', 'type'],
      where: { userId },
      _sum: { amount: true }
    }),
    db.transfer.groupBy({ by: ['destinationId'], where: { userId }, _sum: { amount: true } }),
    db.transfer.groupBy({ by: ['sourceId'], where: { userId }, _sum: { amount: true } })
  ])
  const balances = new Map(accounts.map(account => [account.id, account.openingBalance]))
  const add = (id: string, amount: number) => balances.set(id, (balances.get(id) ?? 0) + amount)
  for (const row of movements)
    add(
      row.accountId ?? `main-${userId}`,
      (row.type === 'Income' ? 1 : -1) * (row._sum.amount ?? 0)
    )
  for (const row of incoming) add(row.destinationId, row._sum.amount ?? 0)
  for (const row of outgoing) add(row.sourceId, -(row._sum.amount ?? 0))
  return accounts.map(account => ({
    ...account,
    targetAmount: account.targetAmount === null ? null : fromCents(account.targetAmount),
    openingBalance: fromCents(account.openingBalance),
    balance: fromCents(balances.get(account.id))
  }))
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
