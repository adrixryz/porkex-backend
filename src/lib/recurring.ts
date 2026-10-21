// Calendar schedules use UTC-midnight days; callers choose the user's local day.
import { prisma } from './prisma'
import { addDays, todayInZone, dayKey } from './dates'
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
    // Native Prisma used integer DATETIMEs; the libSQL adapter writes ISO
    // text. SQLite sorts those storage classes separately, so compare the
    // decoded dates instead. A personal account has few active schedules.
    where: { userId, active: true },
    select: { id: true, nextDate: true }
  })
  if (!rules.length) return { created: 0, state: 'ready' }
  let created = 0
  for (const { id } of rules.filter(rule => rule.nextDate <= today)) {
    created += await prisma.$transaction(async tx => {
      // Re-read under the transaction so cursor and rows advance together.
      const rule = await tx.recurringRule.findFirst({ where: { id, userId, active: true } })
      if (!rule || rule.nextDate > today) return 0
      const frequency = parseFrequency(rule.frequency)
      if (!frequency) throw new Error(`Unknown recurring frequency: ${rule.frequency}`)
      const anchorDay = rule.startDate.getUTCDate()
      let nextDate = rule.nextDate
      let lastProcessedDate = rule.lastProcessedDate
      const dates: Date[] = []
      for (let walked = 0; nextDate <= today && walked < MAX_PER_PASS; walked++) {
        if (rule.endDate && nextDate > rule.endDate) break
        if (!lastProcessedDate || nextDate > lastProcessedDate) {
          dates.push(nextDate)
          lastProcessedDate = nextDate
        }
        nextDate = nextOccurrence(nextDate, frequency, rule.interval, anchorDay)
      }
      // Older deployments may have generated history without the cursor.
      const existing = dates.length
        ? await tx.transaction.findMany({
            where: { recurringId: id, date: { in: dates } },
            select: { date: true }
          })
        : []
      const stored = new Set(existing.map(row => dayKey(row.date)))
      const overrides = await tx.occurrenceOverride.findMany({
        where: { ruleId: id, date: { in: dates } },
        include: { tags: true }
      })
      const overrideByDate = new Map(overrides.map(item => [dayKey(item.date), item]))
      const missing = dates.filter(
        date => !stored.has(dayKey(date)) && overrideByDate.get(dayKey(date))?.kind !== 'SKIP'
      )
      if (missing.length)
        await tx.transaction.createMany({
          data: missing.map(date => ({
            amount: overrideByDate.get(dayKey(date))?.amount ?? rule.amount,
            type: rule.type,
            description: overrideByDate.get(dayKey(date))?.comment ?? rule.description,
            categoryId: overrideByDate.get(dayKey(date))?.categoryId ?? rule.categoryId,
            userId,
            date,
            editedAt: new Date(),
            recurringId: id
          }))
        })
      const edited = overrides.filter(
        item =>
          item.kind === 'EDIT' &&
          missing.some(date => date.getTime() === item.date.getTime()) &&
          item.tags.length
      )
      if (edited.length) {
        const movements = await tx.transaction.findMany({
          where: { recurringId: id, date: { in: edited.map(item => item.date) } },
          select: { id: true, date: true }
        })
        await tx.transactionTag.createMany({
          data: edited.flatMap(item =>
            item.tags.map(tag => ({
              transactionId: movements.find(row => row.date.getTime() === item.date.getTime())!.id,
              tagId: tag.tagId
            }))
          )
        })
      }
      await tx.occurrenceOverride.updateMany({
        where: { ruleId: id, date: { in: dates }, processedAt: null },
        data: { processedAt: new Date() }
      })
      await tx.recurringRule.update({
        where: { id },
        data: { nextDate, lastProcessedDate, active: !(rule.endDate && nextDate > rule.endDate) }
      })
      return missing.length
    })
  }
  const remaining = await prisma.recurringRule.findMany({
    where: { userId, active: true },
    select: { nextDate: true }
  })
  return { created, state: remaining.some(rule => rule.nextDate <= today) ? 'pending' : 'ready' }
}
