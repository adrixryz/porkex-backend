// Calendar schedules use UTC-midnight days; callers choose the user's local day.
import { prisma } from './prisma'
import { movementAccount, balance } from './finance'
import { addDays, todayInZone } from './dates'
import { createRecurringCache } from './recurringCache'
import type { RecurringResult } from './recurringCache'
export type { RecurringResult } from './recurringCache'

export const RECURRING_FREQUENCIES = ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number]

export function parseFrequency(v: unknown): RecurringFrequency | null {
  const s = String(v ?? '').toUpperCase()
  return (RECURRING_FREQUENCIES as readonly string[]).includes(s) ? (s as RecurringFrequency) : null
}

const MAX_PER_PASS = 100

export function nextOccurrence(
  current: Date,
  frequency: RecurringFrequency,
  interval: number,
  anchorDay: number
): Date {
  if (frequency === 'DAY') return addDays(current, interval)
  if (frequency === 'WEEK') return addDays(current, 7 * interval)
  const months = frequency === 'MONTH' ? interval : 12 * interval
  const total = current.getUTCMonth() + months
  const year = current.getUTCFullYear() + Math.floor(total / 12)
  const month = ((total % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay)))
}

export function firstOccurrenceOnOrAfter(
  startDate: Date,
  frequency: RecurringFrequency,
  interval: number,
  minDay: Date
): Date {
  if (startDate >= minDay) return startDate
  if (frequency === 'DAY' || frequency === 'WEEK') {
    const step = interval * (frequency === 'WEEK' ? 7 : 1)
    return addDays(
      startDate,
      Math.ceil((minDay.getTime() - startDate.getTime()) / (step * 86400000)) * step
    )
  }
  const months = frequency === 'MONTH' ? interval : 12 * interval
  const elapsed =
    (minDay.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
    minDay.getUTCMonth() -
    startDate.getUTCMonth()
  const cycles = Math.floor(elapsed / months)
  const anchorDay = startDate.getUTCDate()
  const candidate = nextOccurrence(startDate, frequency, cycles * interval, anchorDay)
  return candidate < minDay ? nextOccurrence(candidate, frequency, interval, anchorDay) : candidate
}

const recurringCache = createRecurringCache(
  materializeUser,
  Date.now,
  process.env.RECURRING_CACHE_TTL_MS === '0' ? 0 : 30_000
)
export const invalidateRecurring = (userId: number) => recurringCache.invalidate(userId)

/** Reuse a recent complete check for the same local day and zone. */
export function runDueRules(
  userId: number,
  now = new Date(),
  timeZone = 'America/Lima'
): Promise<RecurringResult> {
  const today = todayInZone(timeZone, now)
  return recurringCache.run(userId, today, timeZone)
}

async function materializeUser(userId: number, today: Date): Promise<RecurringResult> {
  const rules = await prisma.recurringRule.findMany({
    where: { userId, active: true },
    select: { id: true, nextDate: true }
  })
  let created = 0
  let blocked = false
  for (const { id } of rules.filter(rule => rule.nextDate <= today)) {
    const result = await prisma.$transaction(async tx => {
      const rule = await tx.recurringRule.findFirst({ where: { id, userId, active: true } })
      if (!rule || rule.nextDate > today) return { count: 0, blocked: false }
      const frequency = parseFrequency(rule.frequency)
      if (!frequency) throw new Error(`Unknown recurring frequency: ${rule.frequency}`)
      const account = await movementAccount(userId, rule.accountId, tx)
      let nextDate = rule.nextDate,
        lastProcessedDate = rule.lastProcessedDate,
        count = 0,
        insufficient = false
      for (let walked = 0; nextDate <= today && walked < MAX_PER_PASS; walked++) {
        if (rule.endDate && nextDate > rule.endDate) break
        const override = await tx.occurrenceOverride.findUnique({
          where: { ruleId_date: { ruleId: id, date: nextDate } },
          include: { tags: true }
        })
        const existing = await tx.transaction.findUnique({
          where: { recurringId_date: { recurringId: id, date: nextDate } }
        })
        if (
          (!lastProcessedDate || nextDate > lastProcessedDate) &&
          !existing &&
          override?.kind !== 'SKIP'
        ) {
          const amount = override?.amount ?? rule.amount
          if (rule.type === 'EXPENSE' && (await balance(userId, account.id, tx)) < amount) {
            insufficient = true
            break
          }
          await tx.transaction.create({
            data: {
              accountId: account.id,
              amount,
              type: rule.type,
              description: override?.comment ?? rule.description,
              categoryId: override?.categoryId ?? rule.categoryId,
              userId,
              date: nextDate,
              editedAt: new Date(),
              recurringId: id,
              tags: { create: (override?.tags ?? []).map(tag => ({ tagId: tag.tagId })) }
            }
          })
          count++
        }
        if (override)
          await tx.occurrenceOverride.update({
            where: { ruleId_date: { ruleId: id, date: nextDate } },
            data: { processedAt: new Date() }
          })
        if (!lastProcessedDate || nextDate > lastProcessedDate) lastProcessedDate = nextDate
        nextDate = nextOccurrence(nextDate, frequency, rule.interval, rule.startDate.getUTCDate())
      }
      await tx.recurringRule.update({
        where: { id },
        data: { nextDate, lastProcessedDate, active: !(rule.endDate && nextDate > rule.endDate) }
      })
      return { count, blocked: insufficient }
    })
    created += result.count
    blocked ||= result.blocked
  }
  const remaining = await prisma.recurringRule.findMany({
    where: { userId, active: true },
    select: { nextDate: true }
  })
  return {
    created,
    state: blocked
      ? 'blocked'
      : remaining.some(rule => rule.nextDate <= today)
        ? 'pending'
        : 'ready'
  }
}
