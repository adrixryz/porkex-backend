import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { withServer, createTestUser } from './helpers.mjs'

await withServer('sessions', async ctx => {
  const { user } = await createTestUser(ctx)
  const original = ctx.state.token
  const legacy = jwt.sign({ userId: user.id }, 'test-secret')
  const read = token => ctx.call('GET', '/api/profile', null, { Authorization: `Bearer ${token}` })
  assert.equal((await read(legacy)).status, 200)
  const wrong = await ctx.call('PUT', '/api/password', {
    currentPassword: 'wrong',
    newPassword: 'secret2'
  })
  assert.equal(wrong.status, 400)
  assert.equal((await read(original)).status, 200)
  const revoked = await ctx.call('POST', '/api/sessions/revoke')
  assert.equal(revoked.status, 200)
  assert(revoked.data.token)
  assert.equal((await read(original)).status, 401)
  assert.equal((await read(legacy)).status, 401)
  ctx.state.token = revoked.data.token
  assert.equal((await read(ctx.state.token)).status, 200)
  const changed = await ctx.call('PUT', '/api/password', {
    currentPassword: 'secret1',
    newPassword: 'secret2'
  })
  assert.equal(changed.status, 200)
  assert.equal((await read(ctx.state.token)).status, 401)
  ctx.state.token = changed.data.token
  assert.equal((await read(ctx.state.token)).status, 200)
  assert.equal(
    (await ctx.call('POST', '/auth/login', { email: user.email, password: 'secret1' })).status,
    401
  )
  const login = await ctx.call('POST', '/auth/login', { email: user.email, password: 'secret2' })
  assert.equal(login.status, 200)
  assert.equal((await read(login.data.token)).status, 200)
  await createTestUser(ctx, 'other-sessions@example.com')
  const other = ctx.state.token
  ctx.state.token = changed.data.token
  const simultaneous = await Promise.all([
    ctx.call('POST', '/api/sessions/revoke'),
    ctx.call('POST', '/api/sessions/revoke')
  ])
  assert.deepEqual(simultaneous.map(value => value.status).sort(), [200, 401])
  assert.equal(
    (await read(simultaneous.find(value => value.status === 200).data.token)).status,
    200
  )
  assert.equal((await read(other)).status, 200)
  console.log('PASS sessions: rotation, legacy tokens, password, races and account isolation')
})
