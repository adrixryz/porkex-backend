// Calendar schedules use UTC-midnight days; callers choose the user's local day.
import { prisma } from './prisma'
import { addDays, todayInZone, dayKey } from './dates'

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

export type RecurringResult = { created: number; state: 'ready' | 'pending' }
const running = new Map<string, Promise<RecurringResult>>()

/** Share concurrent catch-up work, never cache completion across later writes. */
export function runDueRules(
  userId: number,
  now = new Date(),
  timeZone = 'America/Lima'
): Promise<RecurringResult> {
  const today = todayInZone(timeZone, now)
  const key = `${userId}:${dayKey(today)}`
  const existing = running.get(key)
  if (existing) return existing
  const work = materializeUser(userId, today).finally(() => {
    running.delete(key)
  })
  running.set(key, work)
  return work
}

async function materializeUser(userId: number, today: Date): Promise<RecurringResult> {
  const rules = await prisma.recurringRule.findMany({
    where: { userId, active: true, nextDate: { lte: today } },
    select: { id: true }
  })
  let created = 0
  for (const { id } of rules) {
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
      const missing = dates.filter(date => !stored.has(dayKey(date)))
      if (missing.length)
        await tx.transaction.createMany({
          data: missing.map(date => ({
            amount: rule.amount,
            type: rule.type,
            description: rule.description,
            categoryId: rule.categoryId,
            userId,
            date,
            recurringId: id
          }))
        })
      await tx.recurringRule.update({
        where: { id },
        data: { nextDate, lastProcessedDate, active: !(rule.endDate && nextDate > rule.endDate) }
      })
      return missing.length
    })
  }
  const pending = await prisma.recurringRule.count({
    where: { userId, active: true, nextDate: { lte: today } }
  })
  return { created, state: pending > 0 ? 'pending' : 'ready' }
}
