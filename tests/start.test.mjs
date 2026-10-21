import assert from 'node:assert/strict'
import { withServer, createTestUser } from './helpers.mjs'
await withServer(
  'compiled-start',
  async ctx => {
    await createTestUser(ctx)
    assert.equal((await ctx.call('GET', '/api/dashboard')).status, 200)
    console.log(
      'PASS compiled production entry starts and authenticates against an isolated database'
    )
  },
  { PORKEX_TEST_COMPILED: 'true' }
)
