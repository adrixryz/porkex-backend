import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
require('ts-node/register/transpile-only')
const { createRecurringCache } = require('../src/lib/recurringCache.ts')
const day = new Date('2026-10-21T00:00:00Z')
let now = 0
let calls = 0
let result = { created: 2, state: 'ready' }
let reject = false
const cache = createRecurringCache(
  async () => {
    calls++
    if (reject) throw new Error('Temporary failure')
    return result
  },
  () => now
)
const run = () => cache.run(1, day, 'America/Lima')
const first = run()
assert.equal(run(), first)
assert.equal((await first).created, 2)
assert.deepEqual(await run(), { created: 0, state: 'ready' })
assert.equal(calls, 1)
now = 30_000
await run()
assert.equal(calls, 2)
await cache.run(2, day, 'America/Lima')
await cache.run(1, day, 'UTC')
await cache.run(1, new Date('2026-10-22T00:00:00Z'), 'America/Lima')
assert.equal(calls, 5)
cache.invalidate(1)
result = { created: 100, state: 'pending' }
await run()
await run()
assert.equal(calls, 7)
reject = true
await assert.rejects(run(), /Temporary failure/)
reject = false
result = { created: 0, state: 'ready' }
await run()
assert.equal(calls, 9)
let finish
let races = 0
const racing = createRecurringCache(() => {
  races++
  return new Promise(resolve => {
    finish = resolve
  })
})
const old = racing.run(1, day, 'UTC')
const resolveOld = finish
racing.invalidate(1)
const fresh = racing.run(1, day, 'UTC')
assert.notEqual(old, fresh)
resolveOld({ created: 0, state: 'ready' })
await old
assert.equal(racing.run(1, day, 'UTC'), fresh)
finish({ created: 0, state: 'pending' })
await fresh
const next = racing.run(1, day, 'UTC')
assert.equal(races, 3)
finish({ created: 0, state: 'ready' })
await next
console.log(
  'PASS recurring cache: query reuse, TTL, zones, days, owners, pending, failure and invalidation races'
)
