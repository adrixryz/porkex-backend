// Money handling.
//
// Amounts live in the database as whole minor units (cents) inside an Int
// column, because that is the only way SQLite stores them exactly. A Prisma
// `Decimal` does not help here: the SQLite connector maps it to REAL, which is
// the same IEEE-754 double a `Float` column would have used.
//
// Rules for this codebase:
//   - Inside a request handler, accumulate in cents (integers). Sums stay exact.
//   - Convert with fromCents() only when writing the JSON response.

const MINOR_UNITS = 100

// A sanity ceiling for user-supplied amounts (ten million units). Cents stay at
// 1e9, below the 32-bit limit of a Prisma Int column, and far below
// Number.MAX_SAFE_INTEGER, so every sum remains exact.
const MAX_MAJOR_UNITS = 10_000_000

/** Parses a positive user-supplied amount (major units) into whole cents. */
export function toCents(v: unknown): number | null {
  const cents = toCentsNonNegative(v)
  return cents !== null && cents > 0 ? cents : null
}

/** Same as toCents but for range filters, where a bound of 0 is meaningful. */
export function toCentsNonNegative(v: unknown): number | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null
  const text = typeof v === 'string' ? v.trim() : String(v)
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0 || n > MAX_MAJOR_UNITS) return null
  return Math.round(n * MINOR_UNITS)
}

/**
 * Converts stored cents into major units for the API response.
 *
 * Accepts fractional cents on purpose: averages divide cents by a day count or
 * a month length, and rounding here is what puts the result back on a 2-decimal
 * boundary.
 */
export function fromCents(cents: number | null | undefined): number {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return 0
  return Math.round(cents) / MINOR_UNITS
}
