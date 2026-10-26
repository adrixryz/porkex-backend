import { BUDGET_PERIODS, type BudgetPeriod } from '../lib/budgetPeriods'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { fromCents, toCents } from '../lib/money'
import { catalogName, catalogNameError } from '../lib/catalogNames'
import { commentInput, resolveTagIds } from '../lib/tags'
import { firstOccurrenceOnOrAfter, parseFrequency, type RecurringFrequency } from '../lib/recurring'
import { addDays, isDayString, parseDay, parseInstant, todayInZone } from '../lib/dates'
import { movementAccount } from '../lib/finance'

export type TxType = 'Income' | 'Expense'

export const MIN_ANALYTICS_MONTHS = 3

export const MAX_ANALYTICS_MONTHS = 12

export const MIN_ANALYTICS_DAYS = 7

export const MAX_ANALYTICS_DAYS = 120

export const SORT_FIELDS = ['date', 'amount'] as const

export const DEFAULT_PER_PAGE = 20

export const MAX_PER_PAGE = 100

export const MAX_DESCRIPTION_LENGTH = 200

export const MAX_CATEGORY_NAME_LENGTH = 60

export const MAX_PROFILE_NAME_LENGTH = 80

export const COLOR_RE = /^#[0-9a-fA-F]{6}$/

export const DEFAULT_PERIODS = ['day', 'week', 'month', 'year'] as const

export const WEEK_DAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY'
] as const

export const DECIMAL_SEPARATORS = ['.', ','] as const

export const WEEK_DAY_INDEX: Record<(typeof WEEK_DAYS)[number], number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6
}

export function isDefaultPeriod(v: unknown): v is (typeof DEFAULT_PERIODS)[number] {
  return DEFAULT_PERIODS.includes(v as (typeof DEFAULT_PERIODS)[number])
}

export function isWeekDay(v: unknown): v is (typeof WEEK_DAYS)[number] {
  return WEEK_DAYS.includes(v as (typeof WEEK_DAYS)[number])
}

export function isValidType(v: unknown): v is TxType {
  return v === 'Income' || v === 'Expense'
}

export function parseCategoryId(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}

export function cleanText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function serializeTransaction<
  T extends {
    amount: number
    description: string
    tags?: { tag: { id: string; name: string; position: number } }[]
  }
>(tx: T) {
  return {
    ...tx,
    comment: tx.description,
    tags: (tx.tags ?? [])
      .map(link => link.tag)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    amount: fromCents(tx.amount)
  }
}

export function parseIntParam(v: unknown, fallback: number): number {
  const n = Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? n : fallback
}

export function resolveToday(query: Record<string, unknown>, fallback: Date): Date | null {
  if (query.today === undefined || query.today === '') return fallback
  if (!isDayString(query.today)) return null
  return parseDay(query.today)
}

export type DateRange = { gte?: Date; lte?: Date }

export function parseRangeBound(v: unknown, endOfDay: boolean): Date | null {
  if (isDayString(v)) {
    const day = parseDay(v)!
    return endOfDay ? new Date(day.getTime() + 86400000 - 1) : day
  }
  return parseInstant(v)
}

export function resolveRange(query: Record<string, unknown>): {
  range?: DateRange
  error?: string
} {
  const range: DateRange = {}

  if (query.from) {
    const from = parseRangeBound(query.from, false)
    if (!from) return { error: 'Invalid "from" date.' }
    range.gte = from
  }

  if (query.to) {
    const to = parseRangeBound(query.to, true)
    if (!to) return { error: 'Invalid "to" date.' }
    range.lte = to
  }

  // An inverted range would silently return nothing; say so instead.
  if (range.gte && range.lte && range.gte > range.lte) {
    return { error: '"from" must be earlier than or equal to "to".' }
  }

  return { range: Object.keys(range).length > 0 ? range : undefined }
}

export function rangeParam(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

export type ClientIdResult = { ok: true; value: string | null } | { ok: false }

export function parseClientId(v: unknown): ClientIdResult {
  const s = cleanText(v)
  if (!s) return { ok: true, value: null }
  if (s.length > 64 || !/^[A-Za-z0-9_-]+$/.test(s)) return { ok: false }
  return { ok: true, value: s }
}

export async function validateTransactionInput(
  userId: number,
  body: {
    accountId?: unknown
    amount: unknown
    type: unknown
    description?: unknown
    comment?: unknown
    tagIds?: unknown
    categoryId: unknown
    date?: unknown
    clientId?: unknown
  },
  db: Prisma.TransactionClient = prisma,
  today: Date = todayInZone()
): Promise<{
  accountId?: string
  error?: string
  amount?: number
  type?: TxType
  description?: string
  tagIds?: string[]
  categoryId?: number
  date?: Date
  clientId?: string
}> {
  const amount = toCents(body.amount)
  if (amount === null)
    return { error: 'Amount must be a positive number within the allowed range.' }

  if (!isValidType(body.type)) return { error: 'Choose Expense or Income.' }

  const description = commentInput(body as Record<string, unknown>)
  if (description === null) return { error: 'Comment must be a string of at most 200 characters.' }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.` }
  }

  const categoryId = parseCategoryId(body.categoryId)
  if (categoryId === null) return { error: 'Valid categoryId is required.' }

  const clientId = parseClientId(body.clientId)
  if (!clientId.ok) {
    return { error: 'clientId must be up to 64 characters of A-Z, a-z, 0-9, dash or underscore.' }
  }

  const category = await db.category.findFirst({ where: { id: categoryId, userId } })
  if (!category) return { error: 'Category not found.' }

  if (category.type !== body.type) {
    return {
      error: `Category "${category.name}" is ${category.type}, but transaction is ${body.type}.`
    }
  }

  // The date is a calendar day stored as UTC midnight. Missing means "use the
  // default" (POST applies today-UTC; PUT keeps the stored date). Future days
  // are rejected so the balance and the analytics never disagree about whether
  // a planned movement counts.
  let date: Date | undefined
  if (body.date !== undefined && body.date !== null && body.date !== '') {
    const parsed = parseDay(body.date)
    if (!parsed) return { error: 'Invalid date.' }
    if (parsed > today) return { error: 'Date cannot be in the future.' }
    date = parsed
  }

  const tagIds =
    body.tagIds === undefined ? undefined : await resolveTagIds(userId, body.tagIds, db)
  if (tagIds === null) return { error: 'Select 0–5 unique tags belonging to this account.' }
  const account = await movementAccount(userId, body.accountId, db)
  return {
    accountId: account.id,
    amount,
    type: body.type,
    description,
    tagIds,
    categoryId,
    date,
    ...(clientId.value ? { clientId: clientId.value } : {})
  }
}

export function validateCategoryInput(body: Record<string, unknown>): {
  error?: string
  name?: string
  type?: TxType
  color?: string | null
} {
  const name = catalogName(body.name, MAX_CATEGORY_NAME_LENGTH)
  if (!name) return { error: `Category name must contain 1–60 characters. ${catalogNameError}` }
  if (!isValidType(body.type)) return { error: 'Choose Expense or Income.' }

  const rawColor = body.color
  if (rawColor === null || rawColor === undefined || rawColor === '') {
    return { name, type: body.type, color: null }
  }
  if (typeof rawColor !== 'string' || !COLOR_RE.test(rawColor)) {
    return { error: 'Color must be a hex value like #RRGGBB.' }
  }
  return { name, type: body.type, color: rawColor }
}

export { BUDGET_PERIODS } from '../lib/budgetPeriods'
export type { BudgetPeriod } from '../lib/budgetPeriods'

export function budgetRange(
  period: BudgetPeriod,
  today: Date,
  weekStart: number
): { from: Date; to: Date } {
  if (period === 'WEEK') {
    const first = addDays(today, -((today.getUTCDay() - weekStart + 7) % 7))
    const last = addDays(first, 6)
    return { from: first, to: new Date(last.getTime() + 86400000 - 1) }
  }
  if (period === 'YEAR')
    return {
      from: new Date(Date.UTC(today.getUTCFullYear(), 0, 1)),
      to: new Date(Date.UTC(today.getUTCFullYear() + 1, 0, 1) - 1)
    }
  return {
    from: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)),
    to: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1) - 1)
  }
}

export function resolveWeekStart(query: Record<string, unknown>): number | null {
  if (query.weekStart === undefined || query.weekStart === '') return WEEK_DAY_INDEX.MONDAY
  if (!isWeekDay(query.weekStart)) return null
  return WEEK_DAY_INDEX[query.weekStart]
}

export function parseBudgetPeriod(v: unknown): BudgetPeriod | null {
  return BUDGET_PERIODS.includes(String(v).toUpperCase() as BudgetPeriod)
    ? (String(v).toUpperCase() as BudgetPeriod)
    : null
}

export const MAX_RECURRING_INTERVAL = 24

export function parseInterval(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return 1
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < 1 || n > MAX_RECURRING_INTERVAL) return null
  return n
}

export function serializeRule<
  T extends {
    amount: number
    description: string
    categoryId: number
    lastProcessedDate?: Date | null
    nextDate?: Date
    exceptions?: {
      date: Date
      amount: number | null
      comment: string | null
      categoryId: number | null
      tags: { tag: { id: string; name: string; position: number } }[]
    }[]
  }
>(rule: T) {
  const { lastProcessedDate: _cursor, exceptions, ...visible } = rule
  const exception = exceptions?.find(
    item =>
      item.date.getTime() === rule.nextDate?.getTime() &&
      ((item.amount ?? rule.amount) !== rule.amount ||
        (item.comment ?? rule.description) !== rule.description ||
        (item.categoryId ?? rule.categoryId) !== rule.categoryId ||
        item.tags.length > 0)
  )
  void _cursor
  return {
    ...visible,
    nextException: exception
      ? {
          date: exception.date,
          amount: fromCents(exception.amount),
          comment: exception.comment ?? '',
          categoryId: exception.categoryId,
          tags: exception.tags.map(link => link.tag).sort((a, b) => a.position - b.position)
        }
      : null,
    comment: (rule as T & { description?: string }).description ?? '',
    amount: fromCents(rule.amount)
  }
}

export async function validateRecurringInput(
  userId: number,
  body: Record<string, unknown>,
  db: Prisma.TransactionClient = prisma
): Promise<{
  error?: string
  amount?: number
  type?: TxType
  description?: string
  categoryId?: number
  frequency?: RecurringFrequency
  interval?: number
  startDate?: Date
  endDate?: Date | null
  clientId?: string
}> {
  const amount = toCents(body.amount)
  if (amount === null) {
    return { error: 'Amount must be a positive number within the allowed range.' }
  }

  if (!isValidType(body.type)) return { error: 'Choose Expense or Income.' }

  const description = commentInput(body)
  if (description === null) return { error: 'Comment must be a string of at most 200 characters.' }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.` }
  }

  const categoryId = parseCategoryId(body.categoryId)
  if (categoryId === null) return { error: 'Valid categoryId is required.' }
  const category = await db.category.findFirst({ where: { id: categoryId, userId } })
  if (!category) return { error: 'Category not found.' }
  if (category.type !== body.type) {
    return {
      error: `Category "${category.name}" is ${category.type}, but the rule is ${body.type}.`
    }
  }

  const frequency = parseFrequency(body.frequency)
  if (!frequency) return { error: 'Frequency must be DAY, WEEK, MONTH or YEAR.' }

  const interval = parseInterval(body.interval)
  if (interval === null) {
    return { error: `Interval must be a whole number between 1 and ${MAX_RECURRING_INTERVAL}.` }
  }

  const startDate = parseDay(body.startDate)
  if (!startDate) return { error: 'A valid start date is required.' }

  let endDate: Date | null = null
  if (body.endDate !== undefined && body.endDate !== null && body.endDate !== '') {
    const parsed = parseDay(body.endDate)
    if (!parsed) return { error: 'Invalid end date.' }
    if (parsed < startDate) return { error: 'The end date must be on or after the start date.' }
    endDate = parsed
  }

  const clientId = parseClientId(body.clientId)
  if (!clientId.ok) {
    return { error: 'clientId must be up to 64 characters of A-Z, a-z, 0-9, dash or underscore.' }
  }

  return {
    amount,
    type: body.type,
    description,
    categoryId,
    frequency,
    interval,
    startDate,
    endDate,
    ...(clientId.value ? { clientId: clientId.value } : {})
  }
}

export function initialNextDate(
  startDate: Date,
  frequency: RecurringFrequency,
  interval: number,
  today: Date
): Date {
  const anchor = startDate > today ? startDate : today
  return firstOccurrenceOnOrAfter(startDate, frequency, interval, anchor)
}

export const PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  currency: true,
  defaultPeriod: true,
  firstDayOfWeek: true,
  decimalSeparator: true,
  createdAt: true
} as const
