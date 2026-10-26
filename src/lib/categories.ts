import type { Prisma } from '@prisma/client'
import { catalogNameKey } from './catalogNames'
import { FinanceError } from './finance'

/** Call within the transaction that creates or updates the category. */
export async function assertCategoryNameAvailable(
  userId: number,
  name: string,
  db: Prisma.TransactionClient,
  exceptId?: number
) {
  return assertCategoryNamesAvailable(userId, [name], db, exceptId)
}

export async function assertCategoryNamesAvailable(
  userId: number,
  names: Iterable<string>,
  db: Prisma.TransactionClient,
  exceptId?: number
) {
  const categories = await db.category.findMany({
    where: { userId },
    select: { id: true, name: true }
  })
  const used = new Set(
    categories
      .filter(category => category.id !== exceptId)
      .map(category => catalogNameKey(category.name))
  )
  for (const name of names) {
    const key = catalogNameKey(name)
    if (used.has(key)) throw new FinanceError('A category with that name already exists.', 409)
    used.add(key)
  }
}

export async function nextCategoryPosition(userId: number, db: Prisma.TransactionClient) {
  const result = await db.category.aggregate({ where: { userId }, _max: { position: true } })
  return (result._max.position ?? -1) + 1
}
