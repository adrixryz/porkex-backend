import { addDays, dayKey } from './dates'
const DAY = 86400000
export function comparisonRanges(
  mode: 'year' | 'week',
  anchor: Date,
  today: Date,
  weekStart: number
) {
  let currentStart: Date, currentEnd: Date, previousStart: Date, previousEnd: Date
  if (mode === 'year') {
    const year = anchor.getUTCFullYear()
    currentStart = new Date(Date.UTC(year, 0, 1))
    const fullEnd = new Date(Date.UTC(year + 1, 0, 1))
    currentEnd = fullEnd <= addDays(today, 1) ? fullEnd : addDays(today, 1)
    previousStart = new Date(Date.UTC(year - 1, 0, 1))
    if (currentEnd.getTime() === fullEnd.getTime()) previousEnd = currentStart
    else {
      const last = addDays(currentEnd, -1)
      const finalDay = Math.min(
        last.getUTCDate(),
        new Date(Date.UTC(year - 1, last.getUTCMonth() + 1, 0)).getUTCDate()
      )
      previousEnd = addDays(new Date(Date.UTC(year - 1, last.getUTCMonth(), finalDay)), 1)
    }
  } else {
    currentStart = addDays(anchor, -((anchor.getUTCDay() - weekStart + 7) % 7))
    currentEnd = new Date(Math.min(addDays(currentStart, 7).getTime(), addDays(today, 1).getTime()))
    previousStart = addDays(currentStart, -7)
    previousEnd = new Date(previousStart.getTime() + currentEnd.getTime() - currentStart.getTime())
  }
  if (currentStart > today) return null
  const partial =
    mode === 'year'
      ? currentEnd.getTime() !== Date.UTC(anchor.getUTCFullYear() + 1, 0, 1)
      : currentEnd.getTime() - currentStart.getTime() < 7 * DAY
  return { currentStart, currentEnd, previousStart, previousEnd, partial }
}
export function compareMovements(
  mode: 'year' | 'week',
  ranges: NonNullable<ReturnType<typeof comparisonRanges>>,
  rows: { amount: number; type: string; date: Date }[]
) {
  const { currentStart, currentEnd, previousStart, previousEnd, partial } = ranges
  const count = mode === 'year' ? 12 : 7
  const zero = () => ({ income: 0, expense: 0, net: 0, count: 0 })
  const current = zero(),
    previous = zero()
  const buckets = Array.from({ length: count }, (_, index) => ({
    index,
    current: zero(),
    previous: zero(),
    included:
      mode === 'year'
        ? index <= addDays(currentEnd, -1).getUTCMonth()
        : index < (currentEnd.getTime() - currentStart.getTime()) / DAY
  }))
  for (const row of rows) {
    const isCurrent = row.date >= currentStart && row.date < currentEnd
    const isPrevious = row.date >= previousStart && row.date < previousEnd
    if (!isCurrent && !isPrevious) continue
    const index =
      mode === 'year'
        ? row.date.getUTCMonth()
        : Math.floor(
            (row.date.getTime() - (isCurrent ? currentStart : previousStart).getTime()) / DAY
          )
    for (const target of [
      isCurrent ? current : previous,
      isCurrent ? buckets[index].current : buckets[index].previous
    ]) {
      if (row.type === 'INCOME') target.income += row.amount
      else target.expense += row.amount
      target.net = target.income - target.expense
      target.count++
    }
  }
  const delta = Object.fromEntries(
    (['income', 'expense', 'net'] as const).map(key => [
      key,
      {
        absolute: (current[key] - previous[key]) / 100,
        percent:
          previous[key] === 0
            ? current[key] === 0
              ? 0
              : null
            : Math.round(((current[key] - previous[key]) / Math.abs(previous[key])) * 10000) / 100
      }
    ])
  )
  const major = (value: ReturnType<typeof zero>) => ({
    income: value.income / 100,
    expense: value.expense / 100,
    net: value.net / 100,
    count: value.count
  })
  return {
    mode,
    partial,
    ranges: {
      current: { from: dayKey(currentStart), to: dayKey(addDays(currentEnd, -1)) },
      previous: { from: dayKey(previousStart), to: dayKey(addDays(previousEnd, -1)) }
    },
    current: major(current),
    previous: major(previous),
    delta,
    buckets: buckets.map(bucket => ({
      index: bucket.index,
      included: bucket.included,
      current: major(bucket.current),
      previous: major(bucket.previous)
    }))
  }
}
