// Calendar-date handling.
//
// A transaction's `date` is a calendar day, not an instant: "the rent was paid
// on the 15th" means the 15th on the user's calendar, wherever the server runs.
// It is stored as UTC midnight of that day, and every aggregation (month and
// day buckets, budget windows, analytics) reads it back with getUTC* — so the
// day can never shift because of the server's timezone.
//
// The client sends either 'YYYY-MM-DD' (what the UI uses) or a full ISO
// timestamp (older queued writes); a timestamp is normalized to the UTC
// calendar day it falls on.

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** True for a well-formed, real 'YYYY-MM-DD' day (rejects 2024-02-31). */
export function isDayString(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = DAY_RE.exec(v)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/**
 * Parses a client-supplied date into UTC midnight of its calendar day.
 * Accepts 'YYYY-MM-DD' and full ISO timestamps. Returns null when unparseable.
 */
export function parseDay(v: unknown): Date | null {
  if (isDayString(v)) {
    const [y, mo, d] = v.split('-').map(Number)
    return new Date(Date.UTC(y, mo - 1, d))
  }
  if (typeof v !== 'string' || !v.trim()) return null
  const parsed = new Date(v)
  if (isNaN(parsed.getTime())) return null
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()))
}

/** Midnight (UTC) of the current UTC day. */
export function utcToday(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400000)
}

// The latest day a movement may be dated: UTC today + 1 day, which covers the
// client's "today" in any timezone from UTC-12 to UTC+14. The UI already limits
// the date picker to the user's own today; this is only a backstop.
export function maxAllowedDay(now = new Date()): Date {
  return addDays(utcToday(now), 1)
}

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`
}

export function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** 'YYYY-MM-DD' of a Date's UTC calendar day, for URL params and tests. */
export function toDayString(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}
