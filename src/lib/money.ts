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

const MINOR_UNITS = 100;

/** Parses a positive user-supplied amount (major units) into whole cents. */
export function toCents(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * MINOR_UNITS);
  // Rejects values that round down to nothing, e.g. 0.001.
  return cents > 0 ? cents : null;
}

/** Same as toCents but for range filters, where a bound of 0 is meaningful. */
export function toCentsNonNegative(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * MINOR_UNITS);
}

/**
 * Converts stored cents into major units for the API response.
 *
 * Accepts fractional cents on purpose: averages divide cents by a day count or
 * a month length, and rounding here is what puts the result back on a 2-decimal
 * boundary.
 */
export function fromCents(cents: number | null | undefined): number {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return 0;
  return Math.round(cents) / MINOR_UNITS;
}