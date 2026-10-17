import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('ts-node/register/transpile-only')
const {
  parseDay,
  parseInstant,
  todayInZone,
  isTimeZone,
  toDayString
} = require('../src/lib/dates.ts')
const { toCents, toCentsNonNegative } = require('../src/lib/money.ts')

for (const bad of [
  '2026-02-31',
  '2026-02-31T00:00:00Z',
  '2025-02-29',
  '10/17/2026',
  '2026-01-01T24:00:00Z'
]) {
  assert.equal(parseDay(bad), null, bad)
}
assert.equal(toDayString(parseDay('2024-02-29')), '2024-02-29')
assert.equal(toDayString(parseDay('2026-10-17T23:00:00-05:00')), '2026-10-18')
assert.equal(parseInstant('2026-02-31T00:00:00Z'), null)
for (const [instant, zone, expected] of [
  ['2026-10-18T00:00:00Z', 'America/Lima', '2026-10-17'],
  ['2026-10-18T04:59:59Z', 'America/Lima', '2026-10-17'],
  ['2026-10-18T05:00:00Z', 'America/Lima', '2026-10-18'],
  ['2026-03-08T06:59:59Z', 'America/New_York', '2026-03-08'],
  ['2026-03-08T07:00:00Z', 'America/New_York', '2026-03-08'],
  ['2026-11-01T05:59:59Z', 'America/New_York', '2026-11-01'],
  ['2026-11-01T06:00:00Z', 'America/New_York', '2026-11-01'],
  ['2026-12-31T11:00:00Z', 'Pacific/Auckland', '2027-01-01']
])
  assert.equal(toDayString(todayInZone(zone, new Date(instant))), expected)
assert.equal(isTimeZone('America/Lima'), true)
assert.equal(isTimeZone('Unknown/City'), false)
for (const bad of [
  true,
  false,
  [],
  [1],
  {},
  null,
  undefined,
  '',
  ' ',
  '1.234',
  1.234,
  NaN,
  Infinity,
  '1e2',
  '0x10',
  -1,
  10_000_000.01
]) {
  assert.equal(toCents(bad), null, String(bad))
  assert.equal(toCentsNonNegative(bad), null, String(bad))
}
assert.equal(toCents('19.99'), 1999)
assert.equal(toCents(0.29), 29)
assert.equal(toCents(10_000_000), 1_000_000_000)
assert.equal(toCentsNonNegative(0), 0)
assert.equal(toCents(0), null)
console.log('PASS calendar boundaries, strict dates and decimal amounts')
