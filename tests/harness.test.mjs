import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { withServer, createTestUser, existsSync } from './helpers.mjs'

const prefix = 'porkex-harness-preparation-failure-'
const before = readdirSync(tmpdir()).filter(name => name.startsWith(prefix))
await assert.rejects(
  withServer('harness-preparation-failure', async () => assert.fail('Server must not start'), {
    NODE_OPTIONS: '--require ./missing-porkex-test-preload.cjs'
  }),
  /Database preparation failed[\s\S]*missing-porkex-test-preload/
)
assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith(prefix)), before)

let databaseFile
await withServer('harness-isolation', async ctx => {
  databaseFile = ctx.dbFile
  const { user } = await createTestUser(ctx)
  ctx.check('test environment always uses an isolated local database', user.email === 'test@example.com')
}, {
  DATABASE_URL: 'libsql://must-never-connect.invalid',
  TURSO_AUTH_TOKEN: 'must-never-be-used',
  JWT_SECRET: 'must-be-overridden'
})
assert.equal(existsSync(databaseFile), false)
console.log('PASS harness isolates database credentials and cleans up failed preparation and completed servers')
