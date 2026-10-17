// Recurring rules and their materialization.
//
// A rule is a template: every occurrence that comes due becomes a real
// Transaction, so the dashboard, the analytics, the budgets and the
// transactions list all keep reading plain rows — and so does the app's own
// offline cache.
//
// There is no scheduler. Materialization is a catch-up that runs before every
// authenticated API call (see routes/api.ts): the next request after a due
// date creates whatever came due, including everything that piled up while the
// free-tier server was asleep. The unique index on (recurringId, date) makes
// the pass idempotent, so running it twice — or from two requests at once —
// cannot produce duplicates.

import type { RecurringRule } from '@prisma/client'
import { prisma } from './prisma'
import { isUniqueViolation } from './errors'
import { addDays, utcToday } from './dates'

export const RECURRING_FREQUENCIES = ['WEEK', 'MONTH', 'YEAR'] as const
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number]

export function parseFrequency(v: unknown): RecurringFrequency | null {
  const s = String(v ?? '').toUpperCase()
  return (RECURRING_FREQUENCIES as readonly string[]).includes(s) ? (s as RecurringFrequency) : null
}

// Safety valve: one rule materializes at most this many movements per pass, so
// a pathological schedule cannot insert thousands of rows in one request.
// Anything left over catches up on the next call (nextDate is persisted).
const MAX_PER_PASS = 100

// The forward walk used when a rule's start date is far in the past. Two
// centuries of weekly occurrences fit; nothing real gets close.
const MAX_WALK = 10_000

/**
 * The occurrence after `current`, keeping the rule's anchor day.
 *
 * Weeks are plain 7-day steps. Months recompute the day from the anchor, so a
 * rule on the 31st lands on Feb 28 (29 in leap years) and returns to the 31st
 * in March, instead of drifting earlier and earlier.
 */
export function nextOccurrence(
  current: Date,
  frequency: RecurringFrequency,
  interval: number,
  anchorDay: number
): Date {
  if (frequency === 'WEEK') return addDays(current, 7 * interval)

  const months = frequency === 'MONTH' ? interval : 12 * interval
  const total = current.getUTCMonth() + months
  const year = current.getUTCFullYear() + Math.floor(total / 12)
  const month = ((total % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay)))
}

/**
 * The first occurrence that falls on or after `minDay`. Used when a rule is
 * created (or resumed, or re-scheduled): the schedule never backfills, it
 * starts at the first occurrence that has not already passed.
 */
export function firstOccurrenceOnOrAfter(
  startDate: Date,
  frequency: RecurringFrequency,
  interval: number,
  minDay: Date
): Date {
  const anchorDay = startDate.getUTCDate()
  let occurrence = startDate
  for (let i = 0; i < MAX_WALK && occurrence < minDay; i++) {
    occurrence = nextOccurrence(occurrence, frequency, interval, anchorDay)
  }
  return occurrence
}

/**
 * Materializes every occurrence that came due, for one user, and returns how
 * many movements it created. Safe to call at any time: with nothing due it is
 * one indexed SELECT and no writes.
 */
export async function runDueRules(userId: number, now = new Date()): Promise<number> {
  const today = utcToday(now)
  const rules = await prisma.recurringRule.findMany({
    where: { userId, active: true, nextDate: { lte: today } }
  })

  let created = 0
  for (const rule of rules) created += await materialize(rule, today)
  return created
}

async function materialize(rule: RecurringRule, today: Date): Promise<number> {
  const frequency = parseFrequency(rule.frequency)
  if (!frequency) {
    // Rows only get here through the validated API, so this is unreachable in
    // practice; skipping the rule is safer than materializing nonsense.
    console.error(`Recurring rule ${rule.id} has an unknown frequency: ${rule.frequency}`)
    return 0
  }

  const anchorDay = rule.startDate.getUTCDate()
  let nextDate = rule.nextDate
  let active = true
  let created = 0

  while (nextDate <= today && created < MAX_PER_PASS) {
    if (rule.endDate && nextDate > rule.endDate) {
      active = false
      break
    }

    try {
      await prisma.transaction.create({
        data: {
          amount: rule.amount,
          type: rule.type,
          description: rule.description,
          categoryId: rule.categoryId,
          userId: rule.userId,
          date: nextDate,
          recurringId: rule.id
        }
      })
      created += 1
    } catch (error) {
      // A duplicate means this date was already materialized — a lost
      // response, a replay or a racing request. Moving on is the answer.
      if (!isUniqueViolation(error)) throw error
    }

    nextDate = nextOccurrence(nextDate, frequency, rule.interval, anchorDay)
  }

  if (rule.endDate && nextDate > rule.endDate) active = false

  await prisma.recurringRule.update({ where: { id: rule.id }, data: { nextDate, active } })
  return created
}
