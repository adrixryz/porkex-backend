import type { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { FinanceError } from './finance'
import { isDayString, parseDay, parseInstant } from './dates'
import { toCentsNonNegative } from './money'

/** The list and CSV export must always apply exactly the same filters. */
export async function transactionFilters(userId: number, q: Record<string, unknown>) {
  const where: Prisma.TransactionWhereInput = { userId }
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const range: { gte?: Date; lte?: Date } = {}
  for (const key of ['from', 'to'] as const) {
    if (!q[key]) continue
    const value = q[key]
    let date = isDayString(value) ? parseDay(value) : parseInstant(value)
    if (!date) throw new FinanceError(`Invalid "${key}" date.`)
    if (key === 'to' && isDayString(value)) date = new Date(date.getTime() + 86400000 - 1)
    range[key === 'from' ? 'gte' : 'lte'] = date
  }
  if (range.gte && range.lte && range.gte > range.lte)
    throw new FinanceError('"from" must be earlier than or equal to "to".')
  if (Object.keys(range).length) where.date = range
  const type = text(q.type)
  if (type && type !== 'ALL') {
    if (type !== 'Income' && type !== 'Expense') throw new FinanceError('Choose Expense or Income.')
    where.type = type
  }
  const categoryId = text(q.categoryId)
  if (categoryId) {
    if (
      !/^\d+$/.test(categoryId) ||
      !Number.isSafeInteger(Number(categoryId)) ||
      Number(categoryId) <= 0
    )
      throw new FinanceError('Invalid categoryId.')
    where.categoryId = Number(categoryId)
  }
  if (q.accountId !== undefined && q.accountId !== '') {
    if (typeof q.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(q.accountId))
      throw new FinanceError('Invalid accountId.')
    const account = await prisma.account.findFirst({
      where: { id: q.accountId, userId, isGoal: false }
    })
    if (!account) throw new FinanceError('Account not found.', 404)
    if (account.isMain) where.AND = [{ OR: [{ accountId: account.id }, { accountId: null }] }]
    else where.accountId = account.id
  }
  if (q.tagId !== undefined && q.tagId !== '') {
    if (typeof q.tagId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(q.tagId))
      throw new FinanceError('Invalid tagId.')
    const ref = await prisma.tagReference.findFirst({ where: { id: q.tagId, tag: { userId } } })
    where.tags = { some: { tagId: ref?.tagId ?? q.tagId, tag: { userId } } }
  }
  for (const key of ['min', 'max'] as const) {
    if (q[key] === undefined || q[key] === '') continue
    const amount = toCentsNonNegative(q[key])
    if (amount === null) throw new FinanceError(`Invalid "${key}" amount.`)
    where.amount = { ...(where.amount as object), [key === 'min' ? 'gte' : 'lte']: amount }
  }
  const amounts = where.amount as { gte?: number; lte?: number } | undefined
  if (amounts?.gte !== undefined && amounts.lte !== undefined && amounts.lte < amounts.gte)
    throw new FinanceError('"max" must be greater than or equal to "min".')
  const search = text(q.search)
  if (search.length > 100) throw new FinanceError('Search must be at most 100 characters.')
  if (search)
    where.OR = [{ description: { contains: search } }, { category: { name: { contains: search } } }]
  return where
}
