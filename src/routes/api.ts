import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { Prisma } from '@prisma/client'
import { AuthRequest, authMiddleware, generateToken } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { isValidCurrency } from '../lib/currencies'
import { fromCents, toCents, toCentsNonNegative } from '../lib/money'
import { isUniqueViolation } from '../lib/errors'
import { passwordError } from '../lib/passwords'
import { tagsRouter } from './tags'
import { comparisonsRouter } from './comparisons'
import { occurrencesRouter } from './occurrences'
import { commentInput, resolveTagIds, tagInclude } from '../lib/tags'
import {
  firstOccurrenceOnOrAfter,
  nextOccurrence,
  parseFrequency,
  runDueRules,
  invalidateRecurring,
  type RecurringFrequency
} from '../lib/recurring'
import {
  addDays,
  dayKey,
  isDayString,
  monthKey,
  parseDay,
  parseInstant,
  isTimeZone,
  todayInZone
} from '../lib/dates'

import { favoritesRouter } from './favorites'
import { accountsRouter } from './accounts'
import { movementAccount, requireFunds, financialWrite, FinanceError } from '../lib/finance'

const router = Router()

// Apply auth middleware to ALL routes in this file
router.use(authMiddleware)

// Materialize due recurring rules before the request runs, so any response
// already reflects today's movements — including the first request after the
// free-tier server woke up. Empty schedules only perform indexed reads.
async function catchUp(req: AuthRequest, res: import('express').Response, refresh = false) {
  try {
    if (refresh) invalidateRecurring(req.userId!)
    const result = await runDueRules(req.userId!, new Date(), res.locals.timeZone)
    res.setHeader('X-Porkex-Recurring-State', result.state)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    res.setHeader('X-Porkex-Recurring-State', 'failed')
    console.error('Recurring catch-up failed.', error)
  }
}

router.use(async (req: AuthRequest, res, next) => {
  const timeZone = req.get('X-Porkex-Time-Zone') ?? 'America/Lima'
  if (!isTimeZone(timeZone)) return res.status(400).json({ error: 'Invalid time zone.' })
  res.locals.timeZone = timeZone
  res.locals.today = todayInZone(timeZone)
  if (
    !['GET', 'HEAD'].includes(req.method) &&
    (req.path.startsWith('/recurring') || /^\/categories\/\d+$/.test(req.path))
  ) {
    invalidateRecurring(req.userId!)
    res.once('finish', () => invalidateRecurring(req.userId!))
  }
  await catchUp(req, res)
  next()
})

router.use(accountsRouter)
router.use('/favorites', favoritesRouter)
router.use('/tags', tagsRouter)
router.use('/analytics', comparisonsRouter)
router.use('/recurring', occurrencesRouter)

type TxType = 'INCOME' | 'EXPENSE'

// The analytics window accepts any whole range within these bounds; the UI
// offers the same limits as editable fields.
const MIN_ANALYTICS_MONTHS = 3
const MAX_ANALYTICS_MONTHS = 12
const MIN_ANALYTICS_DAYS = 7
const MAX_ANALYTICS_DAYS = 120
const SORT_FIELDS = ['date', 'amount'] as const
const DEFAULT_PER_PAGE = 20
const MAX_PER_PAGE = 100
const MAX_SEARCH_LENGTH = 100
const MAX_DESCRIPTION_LENGTH = 200
const MAX_CATEGORY_NAME_LENGTH = 60
const MAX_PROFILE_NAME_LENGTH = 80
// The UI only offers 6-digit hexes; anything else would be a styling surprise.
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

// Display preferences the client mirrors into the account (see PUT /profile).
// The week start also anchors the weekly budget window (see budgetRange).
const DEFAULT_PERIODS = ['day', 'week', 'month', 'year'] as const
const WEEK_DAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY'
] as const
const DECIMAL_SEPARATORS = ['.', ','] as const

// JS Date.getUTCDay(): Sunday is 0. Week windows walk back from it.
const WEEK_DAY_INDEX: Record<(typeof WEEK_DAYS)[number], number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6
}

function isDefaultPeriod(v: unknown): v is (typeof DEFAULT_PERIODS)[number] {
  return DEFAULT_PERIODS.includes(v as (typeof DEFAULT_PERIODS)[number])
}

function isWeekDay(v: unknown): v is (typeof WEEK_DAYS)[number] {
  return WEEK_DAYS.includes(v as (typeof WEEK_DAYS)[number])
}

function isValidType(v: unknown): v is TxType {
  return v === 'INCOME' || v === 'EXPENSE'
}

function parseCategoryId(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}

function cleanText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

// Every amount that leaves the API is converted from cents exactly once, here.
// Everything above this line stays in cents.
function serializeTransaction<
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

function parseIntParam(v: unknown, fallback: number): number {
  const n = Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * The client's "today" as a UTC-midnight calendar day, for windows that depend
 * on "now" (budget periods, analytics buckets). The frontend sends its local
 * date as `today=YYYY-MM-DD`; without it the validated request zone is used.
 * Returns null when the parameter is present but malformed.
 */
function resolveToday(query: Record<string, unknown>, fallback: Date): Date | null {
  if (query.today === undefined || query.today === '') return fallback
  if (!isDayString(query.today)) return null
  return parseDay(query.today)
}

type DateRange = { gte?: Date; lte?: Date }

// One bound of a from/to filter. A plain day ('YYYY-MM-DD') covers that whole
// calendar day (midnight to 23:59:59.999); a full ISO timestamp is used as-is.
function parseRangeBound(v: unknown, endOfDay: boolean): Date | null {
  if (isDayString(v)) {
    const day = parseDay(v)!
    return endOfDay ? new Date(day.getTime() + 86400000 - 1) : day
  }
  return parseInstant(v)
}

// Optional date range shared by /transactions and /categories.
// Returns { error } to answer 400 without repeating the parsing in every route.
function resolveRange(query: Record<string, unknown>): { range?: DateRange; error?: string } {
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

// ── DASHBOARD ──────────────────────────────────────────
router.get('/dashboard', async (req: AuthRequest, res) => {
  const userId = req.userId!
  try {
    const transactions = await prisma.transaction.findMany({
      where: { userId },
      include: { category: true, account: true, ...tagInclude },
      // Most recent by its own date first; id breaks ties between same-day entries.
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: 10
    })

    const [incomeSum, expenseSum, transactionCount] = await Promise.all([
      prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { type: 'INCOME', userId }
      }),
      prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { type: 'EXPENSE', userId }
      }),
      prisma.transaction.count({ where: { userId } })
    ])

    const expensesByCategory = await prisma.transaction.groupBy({
      by: ['categoryId'],
      _sum: { amount: true },
      where: { type: 'EXPENSE', userId }
    })

    // No N+1: a single categories query plus in-memory mapping.
    const categories = await prisma.category.findMany({ where: { userId } })
    const catById = new Map(categories.map(c => [c.id, c]))

    const pieChartData = []
    for (const g of expensesByCategory) {
      const cat = catById.get(g.categoryId)
      if (cat && g._sum.amount) {
        pieChartData.push({
          label: cat.name,
          value: fromCents(g._sum.amount),
          color: cat.color || '#ccc'
        })
      }
    }

    const totalIncome = incomeSum._sum.amount || 0
    const totalExpense = expenseSum._sum.amount || 0

    res.json({
      globalBalance: fromCents(
        totalIncome -
          totalExpense +
          ((await prisma.account.aggregate({ where: { userId }, _sum: { openingBalance: true } }))
            ._sum.openingBalance || 0)
      ),
      totalIncome: fromCents(totalIncome),
      totalExpense: fromCents(totalExpense),
      transactionCount,
      recentTransactions: transactions.map(serializeTransaction),
      pieChartData
    })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to load dashboard', error)
    res.status(500).json({ error: 'Failed to load dashboard' })
  }
})

// ── ANALYTICS ──────────────────────────────────────────

// Reads a whole-number window from the query; missing, fractional or
// out-of-range values fall back to the default.
function rangeParam(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

router.get('/analytics', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const months = rangeParam(req.query.months, MIN_ANALYTICS_MONTHS, MAX_ANALYTICS_MONTHS, 6)
  const days = rangeParam(req.query.days, MIN_ANALYTICS_DAYS, MAX_ANALYTICS_DAYS, 30)

  // Anchor every window on the client's own calendar day, so the buckets do
  // not flip hours before midnight for a user west of UTC (or after it, east).
  const today = resolveToday(req.query as Record<string, unknown>, res.locals.today)
  if (!today) return res.status(400).json({ error: 'Invalid "today" date.' })

  try {
    // Window bounds: months drive the buckets, days drive the balance trend.
    // All arithmetic is UTC; the stored dates are UTC midnights.
    const monthsWindowStart = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (months - 1), 1)
    )
    const trendWindowStart = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1))
    )
    const windowStart = monthsWindowStart < trendWindowStart ? monthsWindowStart : trendWindowStart

    const [categories, windowTx, olderIncome, olderExpense] = await Promise.all([
      prisma.category.findMany({
        where: { userId },
        select: { id: true, name: true, color: true }
      }),
      // Only the rows inside the window are shipped; older ones stay in the DB.
      prisma.transaction.findMany({
        where: { userId, date: { gte: windowStart } },
        select: { amount: true, type: true, date: true, categoryId: true },
        orderBy: { date: 'asc' }
      }),
      // The trend starts with everything before it as opening balance, summed by
      // the database. Two aggregates because income and expense carry signs.
      prisma.transaction.aggregate({
        where: { userId, type: 'INCOME', date: { lt: trendWindowStart } },
        _sum: { amount: true }
      }),
      prisma.transaction.aggregate({
        where: { userId, type: 'EXPENSE', date: { lt: trendWindowStart } },
        _sum: { amount: true }
      })
    ])

    const catById = new Map(categories.map(c => [c.id, c]))
    const openingBalance = (olderIncome._sum.amount || 0) - (olderExpense._sum.amount || 0)

    // Month buckets (income/expense) and day buckets (running balance).
    const monthBuckets: { key: string; label: string; income: number; expense: number }[] = []
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1))
      monthBuckets.push({
        key: monthKey(d),
        label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
        income: 0,
        expense: 0
      })
    }
    const monthIndex = new Map(monthBuckets.map((b, i) => [b.key, i]))
    const currentIdx = monthBuckets.length - 1
    const lastIdx = currentIdx - 1
    const currentKey = monthBuckets[currentIdx].key
    const lastKey = lastIdx >= 0 ? monthBuckets[lastIdx].key : ''

    // Spending per category for the current and previous month (tops and comparison).
    const currentByCat = new Map<number, number>()
    const lastByCat = new Map<number, number>()
    const netByDay = new Map<string, number>()

    // Single pass: O(n) instead of walking every transaction per bucket.
    for (const tx of windowTx) {
      const d = new Date(tx.date)
      const isIncome = tx.type === 'INCOME'
      const net = isIncome ? tx.amount : -tx.amount

      const mi = monthIndex.get(monthKey(d))
      if (mi !== undefined) {
        if (isIncome) {
          monthBuckets[mi].income += tx.amount
        } else {
          monthBuckets[mi].expense += tx.amount
          if (monthBuckets[mi].key === currentKey) {
            currentByCat.set(tx.categoryId, (currentByCat.get(tx.categoryId) || 0) + tx.amount)
          } else if (monthBuckets[mi].key === lastKey) {
            lastByCat.set(tx.categoryId, (lastByCat.get(tx.categoryId) || 0) + tx.amount)
          }
        }
      }

      if (d < trendWindowStart) {
        // Before the trend window but inside the months window: it counts
        // towards the monthly buckets only, never towards the balance.
      } else {
        const dk = dayKey(d)
        netByDay.set(dk, (netByDay.get(dk) || 0) + net)
      }
    }

    const monthlyData = monthBuckets.map((b, i) => {
      const window = monthBuckets.slice(Math.max(0, i - 2), i + 1)
      const avgExpense = window.length
        ? window.reduce((s, x) => s + x.expense, 0) / window.length
        : 0
      return {
        month: b.label,
        income: fromCents(b.income),
        expense: fromCents(b.expense),
        net: fromCents(b.income - b.expense),
        avgExpense: fromCents(avgExpense)
      }
    })

    const trendData: { date: string; balance: number }[] = []
    let balance = openingBalance
    for (let i = 0; i < days; i++) {
      const start = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1) + i)
      )
      balance += netByDay.get(dayKey(start)) || 0
      trendData.push({
        date: start.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC'
        }),
        balance: fromCents(balance)
      })
    }

    const current = monthBuckets[currentIdx]
    const last = lastIdx >= 0 ? monthBuckets[lastIdx] : null

    let expenseChangePercent = 0
    if (last) {
      if (last.expense > 0) {
        expenseChangePercent = Math.round(((current.expense - last.expense) / last.expense) * 100)
      } else if (current.expense > 0) {
        expenseChangePercent = 100
      }
    }

    const catInfo = (id: number) => ({
      name: catById.get(id)?.name || 'Uncategorized',
      color: catById.get(id)?.color || '#5F6368'
    })

    const topCategories = [...currentByCat.entries()]
      .map(([catId, value]) => ({
        ...catInfo(catId),
        value: fromCents(value),
        percent: current.expense > 0 ? Math.round((value / current.expense) * 100) : 0
      }))
      .sort((a, b) => b.value - a.value)

    const comparisonIds = new Set([...currentByCat.keys(), ...lastByCat.keys()])
    const categoryComparison = [...comparisonIds]
      .map(catId => {
        const cur = currentByCat.get(catId) || 0
        const prev = lastByCat.get(catId) || 0
        return {
          ...catInfo(catId),
          current: fromCents(cur),
          previous: fromCents(prev),
          changePercent: prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0
        }
      })
      .sort((a, b) => b.current - a.current)
      .slice(0, 8)

    const dayOfMonth = today.getUTCDate()

    res.json({
      range: { months, days },
      monthlyData,
      trendData,
      topCategories,
      categoryComparison,
      insights: {
        currentMonthIncome: fromCents(current.income),
        currentMonthExpense: fromCents(current.expense),
        lastMonthExpense: fromCents(last?.expense || 0),
        expenseChangePercent,
        avgDailyExpense: dayOfMonth > 0 ? fromCents(current.expense / dayOfMonth) : 0,
        savingsRate:
          current.income > 0
            ? Math.round(((current.income - current.expense) / current.income) * 100)
            : 0,
        topCategories,
        categoryComparison
      }
    })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to load analytics', error)
    res.status(500).json({ error: 'Failed to load analytics' })
  }
})

// ── TRANSACTIONS ───────────────────────────────────────
router.get('/transactions', async (req: AuthRequest, res) => {
  const userId = req.userId!
  try {
    const q = req.query as Record<string, unknown>
    const { range, error } = resolveRange(q)
    if (error) return res.status(400).json({ error })

    const where: Prisma.TransactionWhereInput = { userId }
    if (range) where.date = range

    const type = cleanText(q.type)
    if (type && type !== 'ALL') {
      if (!isValidType(type))
        return res.status(400).json({ error: 'Type must be INCOME or EXPENSE.' })
      where.type = type
    }

    const categoryId = cleanText(q.categoryId)
    if (categoryId) {
      const parsed = parseCategoryId(categoryId)
      if (parsed === null) return res.status(400).json({ error: 'Invalid categoryId.' })
      where.categoryId = parsed
    }

    if (q.tagId !== undefined && q.tagId !== '') {
      if (typeof q.tagId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(q.tagId))
        return res.status(400).json({ error: 'Invalid tagId.' })
      const ref = await prisma.tagReference.findFirst({ where: { id: q.tagId, tag: { userId } } })
      where.tags = { some: { tagId: ref?.tagId ?? q.tagId, tag: { userId } } }
    }

    let minAmount: number | undefined
    if (q.min !== undefined && q.min !== '') {
      const min = toCentsNonNegative(q.min)
      if (min === null) return res.status(400).json({ error: 'Invalid "min" amount.' })
      minAmount = min
      where.amount = { ...(where.amount as object), gte: min }
    }
    if (q.max !== undefined && q.max !== '') {
      const max = toCentsNonNegative(q.max)
      if (max === null) return res.status(400).json({ error: 'Invalid "max" amount.' })
      // Two contradictory bounds would silently return nothing.
      if (minAmount !== undefined && max < minAmount) {
        return res.status(400).json({ error: '"max" must be greater than or equal to "min".' })
      }
      where.amount = { ...(where.amount as object), lte: max }
    }

    const search = cleanText(q.search)
    if (search.length > MAX_SEARCH_LENGTH) {
      return res
        .status(400)
        .json({ error: `Search must be at most ${MAX_SEARCH_LENGTH} characters.` })
    }
    if (search) {
      where.OR = [
        { description: { contains: search } },
        { category: { name: { contains: search } } }
      ]
    }

    // Default order is by the movement date, newest first; id breaks ties.
    const sortBy = SORT_FIELDS.includes(q.sortBy as (typeof SORT_FIELDS)[number])
      ? (q.sortBy as 'date' | 'amount')
      : 'date'
    const order: Prisma.SortOrder = q.order === 'asc' ? 'asc' : 'desc'

    const requestedPage = Math.max(1, parseIntParam(q.page, 1))
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, parseIntParam(q.perPage, DEFAULT_PER_PAGE)))

    const orderBy: Prisma.TransactionOrderByWithRelationInput[] = [
      { [sortBy]: order },
      { id: order }
    ]

    // The count and the page used to be two sequential round trips. They are
    // independent unless the requested page is past the end, because only then
    // does the clamped offset change the read.
    const [total, firstPage] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        include: { category: true, account: true, ...tagInclude },
        orderBy,
        skip: (requestedPage - 1) * perPage,
        take: perPage
      })
    ])

    // Clamp instead of returning an empty page beyond the last one.
    const totalPages = Math.max(1, Math.ceil(total / perPage))
    const page = Math.min(requestedPage, totalPages)

    // Rare: the page asked for does not exist, so re-read at the clamped offset.
    const items =
      page === requestedPage
        ? firstPage
        : await prisma.transaction.findMany({
            where,
            include: { category: true, account: true, ...tagInclude },
            orderBy,
            skip: (page - 1) * perPage,
            take: perPage
          })

    res.json({
      items: items.map(serializeTransaction),
      total,
      page,
      perPage,
      totalPages
    })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to fetch transactions', error)
    res.status(500).json({ error: 'Failed to fetch transactions' })
  }
})

// A client-supplied id, used to make a replayed create safe. Arbitrary strings
// are rejected rather than stored, so the column only ever holds a usable key.
type ClientIdResult = { ok: true; value: string | null } | { ok: false }

function parseClientId(v: unknown): ClientIdResult {
  const s = cleanText(v)
  if (!s) return { ok: true, value: null }
  if (s.length > 64 || !/^[A-Za-z0-9_-]+$/.test(s)) return { ok: false }
  return { ok: true, value: s }
}

async function validateTransactionInput(
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

  if (!isValidType(body.type)) return { error: 'Type must be INCOME or EXPENSE.' }

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

router.post('/transactions', async (req: AuthRequest, res) => {
  const userId = req.userId!

  const findByClientId = (clientId: string | null) =>
    prisma.transaction.findFirst({
      where: { clientId, userId },
      include: { category: true, account: true, ...tagInclude }
    })

  let clientId: string | null = null
  try {
    const parsed = parseClientId(req.body?.clientId)
    if (!parsed.ok) return res.status(400).json({ error: 'Invalid clientId.' })
    clientId = parsed.value

    // Idempotent replay: the frontend queues writes that fail and sends them
    // again later, and a create whose response was lost in transit must not
    // land twice. Answer 200 (not 201) because nothing was created.
    if (clientId) {
      const existing = await findByClientId(clientId)
      if (existing) return res.status(200).json(serializeTransaction(existing))
    }

    const result = await financialWrite(
      userId,
      clientId ? `movement:create:${clientId}` : null,
      async db => {
        const v = await validateTransactionInput(userId, req.body ?? {}, db, res.locals.today)
        if (v.error) throw new FinanceError(v.error)

        const tx = await db.transaction.create({
          data: {
            accountId: v.accountId!,
            amount: v.amount!,
            type: v.type!,
            description: v.description!,
            categoryId: v.categoryId!,
            userId,
            tags: { create: (v.tagIds ?? []).map(tagId => ({ tagId })) },
            // A missing date defaults to today's calendar day (UTC midnight), not
            // to the current instant: `date` is a day, `createdAt` is the clock.
            date: v.date ?? res.locals.today,
            editedAt: new Date(),
            ...(clientId ? { clientId } : {})
          },
          include: { category: true, account: true, ...tagInclude }
        })
        await requireFunds(userId, [v.accountId], db)
        return serializeTransaction(tx)
      }
    )
    invalidateRecurring(userId)
    res.status(201).json(result)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    // Two replays can both pass the lookup above and race to insert. The unique
    // constraint catches the loser, which is the same situation as a replay
    // that had already succeeded, so answer with the stored row.
    if (clientId && isUniqueViolation(error)) {
      const existing = await findByClientId(clientId)
      if (existing) return res.status(200).json(serializeTransaction(existing))
    }
    console.error('Transaction creation failed.', error)
    res.status(500).json({ error: 'Transaction creation failed.' })
  }
})

router.put('/transactions/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const txId = Number(req.params.id)
  if (!Number.isInteger(txId) || txId <= 0) {
    return res.status(400).json({ error: 'Invalid transaction id.' })
  }
  try {
    const editedAt = parseInstant(req.body?.editedAt)
    const mutationId = req.body?.mutationId
    if (typeof mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(mutationId) || !editedAt) {
      return res.status(428).json({
        code: 'CLIENT_UPDATE_REQUIRED',
        error: 'Update Porkex before editing this movement.'
      })
    }
    if (editedAt.getTime() > Date.now() + 5 * 60_000) {
      return res.status(400).json({
        code: 'DEVICE_CLOCK_AHEAD',
        error: 'The device clock is ahead. Enable automatic date and time before retrying.'
      })
    }
    const result = await financialWrite(
      userId,
      `movement:edit:${mutationId}`,
      async db => {
        const existing = await db.transaction.findFirst({
          where: { id: txId, userId },
          include: { category: true, account: true, ...tagInclude }
        })
        if (!existing) return { status: 404, error: 'Transaction not found.' }
        const previousTime = (existing.editedAt ?? existing.createdAt).getTime()
        if (existing.lastEditId === mutationId) return { tx: existing, syncStatus: 'applied' }
        if (
          editedAt.getTime() < previousTime ||
          (editedAt.getTime() === previousTime && mutationId <= (existing.lastEditId ?? ''))
        ) {
          return { tx: existing, syncStatus: 'superseded' }
        }
        const v = await validateTransactionInput(userId, req.body, db, res.locals.today)
        if (v.error) return { status: 400, error: v.error }
        const tx = await db.transaction.update({
          where: { id: txId },
          data: {
            accountId: v.accountId!,
            amount: v.amount!,
            type: v.type!,
            description: v.description!,
            categoryId: v.categoryId!,
            editedAt,
            lastEditId: mutationId,
            ...(v.date ? { date: v.date } : {}),
            ...(v.tagIds !== undefined
              ? { tags: { deleteMany: {}, create: v.tagIds.map(tagId => ({ tagId })) } }
              : {})
          },
          include: { category: true, account: true, ...tagInclude }
        })
        await requireFunds(userId, [existing.accountId, v.accountId], db)
        return { tx, syncStatus: 'applied' }
      },
      async (db, original) => {
        const current = await db.transaction.findFirst({
          where: { id: txId, userId },
          include: { category: true, account: true, ...tagInclude }
        })
        return current
          ? {
              tx: current,
              syncStatus: current.lastEditId === mutationId ? 'applied' : 'superseded'
            }
          : original
      }
    )
    if ('error' in result) return res.status(result.status!).json({ error: result.error })
    invalidateRecurring(userId)
    res.json({ ...serializeTransaction(result.tx!), syncStatus: result.syncStatus })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Transaction update failed.', error)
    res.status(500).json({ error: 'Transaction update failed.' })
  }
})

router.delete('/transactions/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const txId = Number(req.params.id)
  if (!Number.isInteger(txId) || txId <= 0) {
    return res.status(400).json({ error: 'Invalid transaction id.' })
  }
  try {
    await financialWrite(userId, `movement:delete:${txId}`, async db => {
      const existing = await db.transaction.findFirst({ where: { id: txId, userId } })
      if (!existing) throw new FinanceError('Transaction not found.', 404)
      await db.transaction.delete({ where: { id: txId } })
      await requireFunds(userId, [existing.accountId], db)
      return { success: true }
    })
    invalidateRecurring(userId)
    res.json({ success: true })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Delete failed.', error)
    res.status(500).json({ error: 'Delete failed.' })
  }
})

// ── CATEGORIES ─────────────────────────────────────────
router.get('/categories', async (req: AuthRequest, res) => {
  const userId = req.userId!
  try {
    const { range, error } = resolveRange(req.query as Record<string, unknown>)
    if (error) return res.status(400).json({ error })

    const catsPromise = prisma.category.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
      // All-time counts: the UI needs the movement count to know whether
      // deleting requires a reassignment target (which ignores the selected
      // period), and the budget and rule counts to warn about what else goes.
      include: { _count: { select: { transactions: true, budgets: true, recurringRules: true } } }
    })

    const where: Prisma.TransactionWhereInput = { userId }
    if (range) where.date = range

    // Sum and number of movements per category within the same period. The
    // category list and the grouping are independent, so they run together.
    const [cats, sums] = await Promise.all([
      catsPromise,
      prisma.transaction.groupBy({
        by: ['categoryId'],
        where,
        _sum: { amount: true },
        _count: { _all: true }
      })
    ])

    const totalByCat = new Map(sums.map(s => [s.categoryId, fromCents(s._sum.amount || 0)]))
    const countByCat = new Map(sums.map(s => [s.categoryId, s._count._all]))

    res.json(
      cats.map(c => {
        // _count is an implementation detail of this query; the response only
        // carries the two derived totals.
        const { _count, ...rest } = c
        return {
          ...rest,
          transactionCount: countByCat.get(c.id) || 0,
          total: totalByCat.get(c.id) || 0,
          allTimeCount: _count.transactions,
          budgetCount: _count.budgets,
          recurringCount: _count.recurringRules
        }
      })
    )
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to fetch categories', error)
    res.status(500).json({ error: 'Failed to fetch categories' })
  }
})

async function isDuplicateCategoryName(
  userId: number,
  name: string,
  excludeId?: number
): Promise<boolean> {
  const cats = await prisma.category.findMany({ where: { userId } })
  const lower = name.toLowerCase()
  return cats.some(c => c.name.toLowerCase() === lower && c.id !== excludeId)
}

// Shared by POST and PUT. `color` is undefined when the field was not sent at
// all, which PUT uses to keep the stored value; null means "no color".
function validateCategoryInput(body: Record<string, unknown>): {
  error?: string
  name?: string
  type?: TxType
  color?: string | null
} {
  const name = cleanText(body.name)
  if (!name) return { error: 'Category name is required.' }
  if (name.length > MAX_CATEGORY_NAME_LENGTH) {
    return { error: `Category name must be at most ${MAX_CATEGORY_NAME_LENGTH} characters.` }
  }
  if (!isValidType(body.type)) return { error: 'Type must be INCOME or EXPENSE.' }

  const rawColor = body.color
  if (rawColor === null || rawColor === undefined || rawColor === '') {
    return { name, type: body.type, color: null }
  }
  if (typeof rawColor !== 'string' || !COLOR_RE.test(rawColor)) {
    return { error: 'Color must be a hex value like #RRGGBB.' }
  }
  return { name, type: body.type, color: rawColor }
}

router.post('/categories', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const parsed = parseClientId(req.body?.clientId)
  if (!parsed.ok) return res.status(400).json({ error: 'Invalid clientId.' })
  const clientId = parsed.value
  const findExisting = () => prisma.category.findFirst({ where: { userId, clientId } })

  try {
    if (clientId) {
      const existing = await findExisting()
      if (existing) return res.status(200).json(existing)
    }
    const v = validateCategoryInput(req.body ?? {})
    if (v.error) return res.status(400).json({ error: v.error })
    if (await isDuplicateCategoryName(userId, v.name!)) {
      return res.status(409).json({ error: 'A category with that name already exists.' })
    }
    const cat = await prisma.category.create({
      data: { name: v.name!, type: v.type!, color: v.color ?? null, userId, clientId }
    })
    res.status(201).json(cat)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    // Two concurrent creates with the same name can both pass the check above.
    if (isUniqueViolation(error)) {
      if (clientId) {
        const existing = await findExisting()
        if (existing) return res.status(200).json(existing)
      }
      return res.status(409).json({ error: 'A category with that name already exists.' })
    }
    console.error('Category creation failed.', error)
    res.status(500).json({ error: 'Category creation failed.' })
  }
})

router.put('/categories/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const catId = Number(req.params.id)
  if (!Number.isInteger(catId) || catId <= 0) {
    return res.status(400).json({ error: 'Invalid category id.' })
  }
  const v = validateCategoryInput(req.body ?? {})
  if (v.error) return res.status(400).json({ error: v.error })

  try {
    const existing = await prisma.category.findFirst({ where: { id: catId, userId } })
    if (!existing) return res.status(404).json({ error: 'Category not found.' })

    if (await isDuplicateCategoryName(userId, v.name!, catId)) {
      return res.status(409).json({ error: 'A category with that name already exists.' })
    }

    // Do not allow changing the type when transactions already reference it.
    if (existing.type !== v.type) {
      const txCount = await prisma.transaction.count({ where: { categoryId: catId, userId } })
      if (txCount > 0) {
        return res
          .status(409)
          .json({ error: 'Cannot change type: category has existing transactions.' })
      }
      const incompatibleOverrides = await prisma.occurrenceOverride.count({
        where: { categoryId: catId, processedAt: null }
      })
      if (incompatibleOverrides)
        return res.status(409).json({
          error: 'Category is used by a next-only edit. Edit or skip that occurrence first.'
        })
      const incompatibleRules = await prisma.recurringRule.count({
        where: { categoryId: catId, userId, type: { not: v.type! } }
      })
      if (incompatibleRules > 0) {
        return res
          .status(409)
          .json({ error: 'Cannot change type: category has incompatible recurring rules.' })
      }
    }

    const cat = await prisma.category.update({
      where: { id: catId },
      // A missing color keeps the stored one; a sent color replaces it.
      data: { name: v.name!, type: v.type!, color: v.color === null ? existing.color : v.color }
    })
    res.json(cat)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: 'A category with that name already exists.' })
    }
    console.error('Category update failed.', error)
    res.status(500).json({ error: 'Category update failed.' })
  }
})

router.delete('/categories/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const catId = Number(req.params.id)
  if (!Number.isInteger(catId) || catId <= 0) {
    return res.status(400).json({ error: 'Invalid category id.' })
  }
  try {
    const existing = await prisma.category.findFirst({ where: { id: catId, userId } })
    if (!existing) return res.status(404).json({ error: 'Category not found.' })

    if (await prisma.occurrenceOverride.count({ where: { categoryId: catId, processedAt: null } }))
      return res.status(409).json({
        error: 'Category is used by a next-only edit. Edit or skip that occurrence first.'
      })
    const txCount = await prisma.transaction.count({ where: { categoryId: catId, userId } })
    if (txCount === 0) {
      // Recurring rules go with their category. Deleted explicitly — not left
      // to the foreign key — because the additive deploy tool cannot add or
      // change constraints on the production tables.
      await prisma.$transaction([
        prisma.recurringRule.deleteMany({ where: { categoryId: catId, userId } }),
        prisma.category.delete({ where: { id: catId } })
      ])
      return res.json({ success: true, moved: 0 })
    }

    // With movements a target category is required; without it the request is rejected.
    const rawTarget = req.query.reassignTo ?? req.body?.reassignTo
    if (rawTarget === undefined || rawTarget === null || rawTarget === '') {
      return res.status(409).json({
        error: 'Cannot delete category with existing transactions.',
        needsReassignment: true,
        transactionCount: txCount
      })
    }

    const targetId = parseCategoryId(rawTarget)
    if (targetId === null) {
      return res.status(400).json({ error: 'Invalid reassignment target category.' })
    }
    if (targetId === catId) {
      return res.status(400).json({ error: 'Cannot reassign transactions to the same category.' })
    }

    const target = await prisma.category.findFirst({ where: { id: targetId, userId } })
    if (!target) return res.status(404).json({ error: 'Target category not found.' })
    if (target.type !== existing.type) {
      return res.status(400).json({
        error: `Target category "${target.name}" is ${target.type}, but "${existing.name}" is ${existing.type}.`
      })
    }

    await prisma.$transaction([
      // Movements generated by this category's rules lose the pointer to
      // their template before it disappears (same reason as above).
      prisma.transaction.updateMany({
        where: { userId, recurring: { categoryId: catId } },
        data: { recurringId: null }
      }),
      prisma.recurringRule.deleteMany({ where: { categoryId: catId, userId } }),
      prisma.transaction.updateMany({
        where: { categoryId: catId, userId },
        data: { categoryId: targetId, editedAt: new Date(), lastEditId: randomUUID() }
      }),
      prisma.category.delete({ where: { id: catId } })
    ])

    res.json({ success: true, moved: txCount, reassignedTo: target.name })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Delete failed.', error)
    res.status(500).json({ error: 'Delete failed.' })
  }
})

// ── BUDGETS ────────────────────────────────────────────
const BUDGET_PERIODS = ['WEEK', 'MONTH'] as const
type BudgetPeriod = (typeof BUDGET_PERIODS)[number]

// The window a budget covers, in UTC calendar days. Weeks start on the day the
// client configured (Monday by default, the historical behaviour). `today` is
// the client's own calendar day (see resolveToday), so a user west of UTC does
// not see the window roll over hours before their midnight.
function budgetRange(
  period: BudgetPeriod,
  today: Date,
  weekStart: number
): { from: Date; to: Date } {
  if (period === 'WEEK') {
    const first = addDays(today, -((today.getUTCDay() - weekStart + 7) % 7))
    const last = addDays(first, 6)
    return { from: first, to: new Date(last.getTime() + 86400000 - 1) }
  }
  return {
    from: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)),
    to: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1) - 1)
  }
}

// The first day of the week the client's windows are anchored to, as a
// getUTCDay() index. Absent means Monday, so requests without the preference
// (or older clients) keep working.
function resolveWeekStart(query: Record<string, unknown>): number | null {
  if (query.weekStart === undefined || query.weekStart === '') return WEEK_DAY_INDEX.MONDAY
  if (!isWeekDay(query.weekStart)) return null
  return WEEK_DAY_INDEX[query.weekStart]
}

function parseBudgetPeriod(v: unknown): BudgetPeriod | null {
  return BUDGET_PERIODS.includes(String(v).toUpperCase() as BudgetPeriod)
    ? (String(v).toUpperCase() as BudgetPeriod)
    : null
}

router.get('/budgets', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const requested = req.query.period ? parseBudgetPeriod(req.query.period) : null
  if (req.query.period && !requested) {
    return res.status(400).json({ error: 'Period must be WEEK or MONTH.' })
  }

  const today = resolveToday(req.query as Record<string, unknown>, res.locals.today)
  if (!today) return res.status(400).json({ error: 'Invalid "today" date.' })

  const weekStart = resolveWeekStart(req.query as Record<string, unknown>)
  if (weekStart === null) {
    return res.status(400).json({ error: 'Week start must be a day name (e.g. MONDAY).' })
  }

  try {
    // No period filter means both, so each budget is measured on its own cycle.
    const budgets = await prisma.budget.findMany({
      where: requested ? { userId, period: requested } : { userId },
      include: { category: { select: { id: true, name: true, color: true, type: true } } },
      orderBy: { id: 'asc' }
    })

    // A WEEK and a MONTH budget for the same category need different sums, so
    // spending is grouped once per period present in the list.
    const periods = [...new Set(budgets.map(b => b.period as BudgetPeriod))]
    const spentByPeriod = new Map<BudgetPeriod, Map<number, number>>()

    for (const period of periods) {
      const window = budgetRange(period, today, weekStart)
      const grouped = await prisma.transaction.groupBy({
        by: ['categoryId'],
        where: { userId, date: { gte: window.from, lte: window.to } },
        _sum: { amount: true }
      })
      spentByPeriod.set(period, new Map(grouped.map(g => [g.categoryId, g._sum.amount || 0])))
    }

    const spentFor = (period: BudgetPeriod, categoryId: number): number =>
      spentByPeriod.get(period)?.get(categoryId) ?? 0

    const payload = budgets.map(b => {
      const period = b.period as BudgetPeriod
      const spent = spentFor(period, b.categoryId)
      return {
        id: b.id,
        categoryId: b.categoryId,
        amount: fromCents(b.amount),
        period: b.period,
        spent: fromCents(spent),
        remaining: fromCents(b.amount - spent),
        usagePercent: b.amount > 0 ? Math.round((spent / b.amount) * 100) : 0,
        overBudget: spent > b.amount,
        category: b.category
      }
    })

    // Totals are grouped by period on purpose: a WEEK and a MONTH budget on the
    // same category cover the same movements, so summing them all would count twice.
    // Summed over the raw rows so the arithmetic stays in exact cents.
    const totals = periods.map(period => {
      const rows = budgets.filter(b => b.period === period)
      const amount = rows.reduce((s, b) => s + b.amount, 0)
      const spent = rows.reduce((s, b) => s + spentFor(period, b.categoryId), 0)
      return {
        period,
        amount: fromCents(amount),
        spent: fromCents(spent),
        // Any single budget over its limit flags the period, not just the aggregate.
        overBudget: rows.some(b => spentFor(period, b.categoryId) > b.amount),
        count: rows.length
      }
    })

    res.json({ budgets: payload, totals })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to fetch budgets', error)
    res.status(500).json({ error: 'Failed to fetch budgets' })
  }
})

router.post('/budgets', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const parsed = parseClientId(req.body?.clientId)
  if (!parsed.ok) return res.status(400).json({ error: 'Invalid clientId.' })
  const clientId = parsed.value
  const findExisting = () =>
    prisma.budget.findFirst({
      where: { userId, clientId },
      include: { category: { select: { id: true, name: true, color: true, type: true } } }
    })
  const replyExisting = async () => {
    if (!clientId) return false
    const existing = await findExisting()
    if (!existing) return false
    res.status(200).json({ ...existing, amount: fromCents(existing.amount) })
    return true
  }
  try {
    if (await replyExisting()) return
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Budget replay failed.', error)
    return res.status(500).json({ error: 'Budget creation failed.' })
  }
  const amount = toCents(req.body?.amount)
  if (amount === null) {
    return res
      .status(400)
      .json({ error: 'Amount must be a positive number within the allowed range.' })
  }

  const period = parseBudgetPeriod(req.body?.period)
  if (!period) {
    return res.status(400).json({ error: 'Period must be WEEK or MONTH.' })
  }

  const categoryId = parseCategoryId(req.body?.categoryId)
  if (categoryId === null) {
    return res.status(400).json({ error: 'Valid categoryId is required.' })
  }

  try {
    const category = await prisma.category.findFirst({ where: { id: categoryId, userId } })
    if (!category) return res.status(404).json({ error: 'Category not found.' })

    const existing = await prisma.budget.findFirst({ where: { userId, categoryId, period } })
    if (existing) {
      return res.status(409).json({ error: 'This category already has a budget for that period.' })
    }

    const budget = await prisma.budget.create({
      data: { userId, categoryId, amount, period, clientId },
      include: { category: { select: { id: true, name: true, color: true, type: true } } }
    })
    res.status(201).json({ ...budget, amount: fromCents(budget.amount) })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    // Two concurrent creates can both pass the "already exists" check.
    if (isUniqueViolation(error)) {
      if (await replyExisting()) return
      return res.status(409).json({ error: 'This category already has a budget for that period.' })
    }
    console.error('Budget creation failed.', error)
    res.status(500).json({ error: 'Budget creation failed.' })
  }
})

router.put('/budgets/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const budgetId = Number(req.params.id)
  if (!Number.isInteger(budgetId) || budgetId <= 0) {
    return res.status(400).json({ error: 'Invalid budget id.' })
  }

  const amount = toCents(req.body?.amount)
  if (amount === null) {
    return res
      .status(400)
      .json({ error: 'Amount must be a positive number within the allowed range.' })
  }

  const period = parseBudgetPeriod(req.body?.period)
  if (!period) {
    return res.status(400).json({ error: 'Period must be WEEK or MONTH.' })
  }

  try {
    const existing = await prisma.budget.findFirst({ where: { id: budgetId, userId } })
    if (!existing) return res.status(404).json({ error: 'Budget not found.' })

    const taken = await prisma.budget.findFirst({
      where: { userId, categoryId: existing.categoryId, period, id: { not: budgetId } }
    })
    if (taken) {
      return res.status(409).json({ error: 'This category already has a budget for that period.' })
    }

    const budget = await prisma.budget.update({
      where: { id: budgetId },
      data: { amount, period },
      include: { category: { select: { id: true, name: true, color: true, type: true } } }
    })
    res.json({ ...budget, amount: fromCents(budget.amount) })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: 'This category already has a budget for that period.' })
    }
    console.error('Budget update failed.', error)
    res.status(500).json({ error: 'Budget update failed.' })
  }
})

router.delete('/budgets/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const budgetId = Number(req.params.id)
  if (!Number.isInteger(budgetId) || budgetId <= 0) {
    return res.status(400).json({ error: 'Invalid budget id.' })
  }
  try {
    const existing = await prisma.budget.findFirst({ where: { id: budgetId, userId } })
    if (!existing) return res.status(404).json({ error: 'Budget not found.' })

    await prisma.budget.delete({ where: { id: budgetId } })
    res.json({ success: true })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Delete failed.', error)
    res.status(500).json({ error: 'Delete failed.' })
  }
})

// ── RECURRING ──────────────────────────────────────────
const MAX_RECURRING_INTERVAL = 24

function parseInterval(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return 1
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < 1 || n > MAX_RECURRING_INTERVAL) return null
  return n
}

function serializeRule<
  T extends {
    amount: number
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
  const exception = exceptions?.find(item => item.date.getTime() === rule.nextDate?.getTime())
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

async function validateRecurringInput(
  userId: number,
  body: Record<string, unknown>
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

  if (!isValidType(body.type)) return { error: 'Type must be INCOME or EXPENSE.' }

  const description = commentInput(body)
  if (description === null) return { error: 'Comment must be a string of at most 200 characters.' }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.` }
  }

  const categoryId = parseCategoryId(body.categoryId)
  if (categoryId === null) return { error: 'Valid categoryId is required.' }
  const category = await prisma.category.findFirst({ where: { id: categoryId, userId } })
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

/**
 * The first occurrence that has not already passed. The schedule never
 * backfills: a rule created (or resumed, or re-scheduled) today starts at the
 * next occurrence — today itself when it falls on the schedule.
 */
function initialNextDate(
  startDate: Date,
  frequency: RecurringFrequency,
  interval: number,
  today: Date
): Date {
  const anchor = startDate > today ? startDate : today
  return firstOccurrenceOnOrAfter(startDate, frequency, interval, anchor)
}

router.get('/recurring', async (req: AuthRequest, res) => {
  const userId = req.userId!
  try {
    const rules = await prisma.recurringRule.findMany({
      where: { userId },
      include: {
        category: true,
        exceptions: { where: { processedAt: null }, include: { tags: { include: { tag: true } } } }
      },
      // Active rules first; within each group, the ones that come due next.
      orderBy: [{ active: 'desc' }, { nextDate: 'asc' }, { id: 'asc' }]
    })
    res.json(rules.map(serializeRule))
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to fetch recurring rules.', error)
    res.status(500).json({ error: 'Failed to fetch recurring rules.' })
  }
})

router.post('/recurring', async (req: AuthRequest, res) => {
  const userId = req.userId!

  const findByClientId = (clientId: string | null) =>
    prisma.recurringRule.findFirst({
      where: { clientId, userId },
      include: {
        category: true,
        exceptions: { where: { processedAt: null }, include: { tags: { include: { tag: true } } } }
      }
    })

  let clientId: string | null = null
  try {
    const parsed = parseClientId(req.body?.clientId)
    if (!parsed.ok) return res.status(400).json({ error: 'Invalid clientId.' })
    clientId = parsed.value

    // Idempotent replay, exactly like POST /transactions: the frontend queues
    // writes that fail, and a create whose response was lost must not turn
    // into a second rule — which would double every future movement.
    if (clientId) {
      const existing = await findByClientId(clientId)
      if (existing) return res.status(200).json(serializeRule(existing))
    }

    const v = await validateRecurringInput(userId, req.body ?? {})
    if (v.error) return res.status(400).json({ error: v.error })

    const account = await movementAccount(userId, req.body.accountId)
    const created = await prisma.recurringRule.create({
      data: {
        accountId: account.id,
        userId,
        amount: v.amount!,
        type: v.type!,
        description: v.description!,
        categoryId: v.categoryId!,
        frequency: v.frequency!,
        interval: v.interval!,
        startDate: v.startDate!,
        endDate: v.endDate ?? null,
        nextDate: initialNextDate(v.startDate!, v.frequency!, v.interval!, res.locals.today),
        ...(clientId ? { clientId } : {})
      },
      include: {
        category: true,
        exceptions: { where: { processedAt: null }, include: { tags: { include: { tag: true } } } }
      }
    })

    // Materialize right away when the first occurrence falls on today, so the
    // response already reflects it instead of waiting for the next request.
    await catchUp(req, res, true)

    const fresh = await prisma.recurringRule.findUnique({
      where: { id: created.id },
      include: {
        category: true,
        exceptions: { where: { processedAt: null }, include: { tags: { include: { tag: true } } } }
      }
    })
    res.status(201).json(serializeRule(fresh ?? created))
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    // Two replays racing: the loser answers with the stored row, like POST
    // /transactions does.
    if (clientId && isUniqueViolation(error)) {
      const existing = await findByClientId(clientId)
      if (existing) return res.status(200).json(serializeRule(existing))
    }
    console.error('Recurring rule creation failed.', error)
    res.status(500).json({ error: 'Recurring rule creation failed.' })
  }
})

router.put('/recurring/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const ruleId = Number(req.params.id)
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    return res.status(400).json({ error: 'Invalid recurring rule id.' })
  }
  try {
    const existing = await prisma.recurringRule.findFirst({ where: { id: ruleId, userId } })
    if (!existing) return res.status(404).json({ error: 'Recurring rule not found.' })

    const v = await validateRecurringInput(userId, req.body)
    if (v.error) return res.status(400).json({ error: v.error })

    // Re-scheduling and resuming both restart the schedule at the first
    // occurrence that has not passed: the periods a pause (or an edit) skipped
    // are never materialized after the fact. The middleware already ran the
    // catch-up, so an occurrence that just materialized is not reconsidered.
    const endDate = req.body.endDate === undefined ? existing.endDate : (v.endDate ?? null)

    let active = typeof req.body.active === 'boolean' ? req.body.active : existing.active
    const scheduleChanged =
      existing.startDate.getTime() !== v.startDate!.getTime() ||
      existing.frequency !== v.frequency ||
      existing.interval !== v.interval
    const resumed = !existing.active && active
    let nextDate = existing.nextDate
    if (scheduleChanged || resumed) {
      const processedFloor = existing.lastProcessedDate
        ? addDays(existing.lastProcessedDate, 1)
        : res.locals.today
      const floor = processedFloor > res.locals.today ? processedFloor : res.locals.today
      nextDate = initialNextDate(v.startDate!, v.frequency!, v.interval!, floor)
    }
    // A future skip excludes its exact date, not every earlier calendar day.
    const skipped = await prisma.occurrenceOverride.findMany({
      where: { ruleId, kind: 'SKIP' },
      select: { date: true }
    })
    const skippedDays = new Set(skipped.map(item => dayKey(item.date)))
    while (skippedDays.has(dayKey(nextDate)))
      nextDate = nextOccurrence(nextDate, v.frequency!, v.interval!, v.startDate!.getUTCDate())
    if (endDate && nextDate > endDate) active = false

    const updated = await prisma.$transaction(async db => {
      await db.occurrenceOverride.deleteMany({
        where: {
          ruleId,
          processedAt: null,
          ...(existing.type !== v.type ? {} : { date: { not: nextDate } })
        }
      })
      const account = await movementAccount(userId, req.body.accountId ?? existing.accountId, db)
      const rule = await db.recurringRule.update({
        where: { id: ruleId },
        data: {
          accountId: account.id,
          amount: v.amount!,
          type: v.type!,
          description: v.description!,
          categoryId: v.categoryId!,
          frequency: v.frequency!,
          interval: v.interval!,
          startDate: v.startDate!,
          endDate,
          nextDate,
          active
        },
        include: {
          category: true,
          exceptions: {
            where: { processedAt: null },
            include: { tags: { include: { tag: true } } }
          }
        }
      })
      return rule
    })

    // A resume may make today's occurrence due again; settle it before
    // reading back so the response carries the advanced next date.
    await catchUp(req, res, true)

    const fresh = await prisma.recurringRule.findUnique({
      where: { id: ruleId },
      include: {
        category: true,
        exceptions: { where: { processedAt: null }, include: { tags: { include: { tag: true } } } }
      }
    })
    res.json(serializeRule(fresh ?? updated))
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Recurring rule update failed.', error)
    res.status(500).json({ error: 'Recurring rule update failed.' })
  }
})

router.delete('/recurring/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const ruleId = Number(req.params.id)
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    return res.status(400).json({ error: 'Invalid recurring rule id.' })
  }
  try {
    const existing = await prisma.recurringRule.findFirst({ where: { id: ruleId, userId } })
    if (!existing) return res.status(404).json({ error: 'Recurring rule not found.' })

    // The movements the rule already created are history: they stay, and only
    // lose the pointer to their template. Done here rather than left to the
    // foreign key's ON DELETE action, because the additive deploy tool cannot
    // add constraints to an existing production table.
    await prisma.$transaction([
      prisma.transaction.updateMany({
        where: { userId, recurringId: ruleId },
        data: { recurringId: null }
      }),
      prisma.recurringRule.delete({ where: { id: ruleId } })
    ])

    res.json({ success: true })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Recurring rule delete failed.', error)
    res.status(500).json({ error: 'Recurring rule delete failed.' })
  }
})

// ── USER PROFILE ───────────────────────────────────────
const PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  currency: true,
  defaultPeriod: true,
  firstDayOfWeek: true,
  decimalSeparator: true,
  createdAt: true
} as const

router.get('/profile', async (req: AuthRequest, res) => {
  const userId = req.userId!
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: PROFILE_SELECT
    })
    if (!user) return res.status(404).json({ error: 'User not found.' })
    res.json(user)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to fetch profile.', error)
    res.status(500).json({ error: 'Failed to fetch profile.' })
  }
})

router.put('/profile', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const data: {
    name?: string
    currency?: string
    defaultPeriod?: string
    firstDayOfWeek?: string
    decimalSeparator?: string
  } = {}

  // Every field is optional, so the client can update one without sending the others.
  if (req.body?.name !== undefined) {
    const name = cleanText(req.body.name)
    if (!name) {
      return res.status(400).json({ error: 'Name is required.' })
    }
    if (name.length > MAX_PROFILE_NAME_LENGTH) {
      return res
        .status(400)
        .json({ error: `Name must be at most ${MAX_PROFILE_NAME_LENGTH} characters.` })
    }
    data.name = name
  }

  if (req.body?.currency !== undefined) {
    if (!isValidCurrency(req.body.currency)) {
      return res.status(400).json({ error: 'Unsupported currency code.' })
    }
    data.currency = req.body.currency
  }

  if (req.body?.defaultPeriod !== undefined) {
    if (!isDefaultPeriod(req.body.defaultPeriod)) {
      return res.status(400).json({ error: 'Default period must be day, week, month or year.' })
    }
    data.defaultPeriod = req.body.defaultPeriod
  }

  if (req.body?.firstDayOfWeek !== undefined) {
    if (!isWeekDay(req.body.firstDayOfWeek)) {
      return res.status(400).json({ error: 'First day of the week must be a day name.' })
    }
    data.firstDayOfWeek = req.body.firstDayOfWeek
  }

  if (req.body?.decimalSeparator !== undefined) {
    if (!DECIMAL_SEPARATORS.includes(req.body.decimalSeparator)) {
      return res.status(400).json({ error: 'Decimal separator must be "." or ",".' })
    }
    data.decimalSeparator = req.body.decimalSeparator
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' })
  }

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: PROFILE_SELECT
    })
    res.json(user)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Profile update failed.', error)
    res.status(500).json({ error: 'Profile update failed.' })
  }
})

// ── PASSWORD ───────────────────────────────────────────
router.post('/sessions/revoke', async (req: AuthRequest, res) => {
  try {
    const version = req.sessionVersion!
    const updated = await prisma.user.updateMany({
      where: { id: req.userId!, sessionVersion: version },
      data: { sessionVersion: { increment: 1 } }
    })
    if (!updated.count)
      return res.status(401).json({ error: 'This session was revoked. Sign in again.' })
    res.json({ success: true, token: generateToken(req.userId!, version + 1) })
  } catch {
    res
      .status(503)
      .json({ error: 'Could not confirm session revocation. Sign in again if necessary.' })
  }
})

router.put('/password', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const currentPassword = req.body?.currentPassword
  const newPassword = req.body?.newPassword

  if (
    typeof currentPassword !== 'string' ||
    !currentPassword ||
    typeof newPassword !== 'string' ||
    !newPassword
  ) {
    return res.status(400).json({ error: 'Current and new password are required.' })
  }

  // Same policy as registration (see lib/passwords.ts).
  const pwError = passwordError(newPassword, 'New password')
  if (pwError) return res.status(400).json({ error: pwError })

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return res.status(404).json({ error: 'User not found.' })

    const valid = await bcrypt.compare(currentPassword, user.password)
    // 400, never 401: the frontend treats a 401 as an expired session and
    // would log the user out over a simple typo.
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect.' })

    const hashed = await bcrypt.hash(newPassword, 10)
    const updated = await prisma.user.updateMany({
      where: { id: userId, sessionVersion: req.sessionVersion!, password: user.password },
      data: { password: hashed, sessionVersion: { increment: 1 } }
    })
    if (!updated.count)
      return res.status(401).json({ error: 'This session was revoked. Sign in again.' })
    res.json({ success: true, token: generateToken(userId, req.sessionVersion! + 1) })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Password change failed.', error)
    res.status(500).json({ error: 'Password change failed.' })
  }
})

export default router
