import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { withServer } from './helpers.mjs'

await withServer(
  'registration-closed',
  async ctx => {
    const { call, check, dbFile, state } = ctx
    check(
      'registration config is public and explicitly closed',
      (await call('GET', '/auth/config')).data.registrationEnabled === false
    )
    check(
      'registration is rejected before validating credentials',
      (await call('POST', '/auth/register', {})).status === 403
    )
    const seeded = spawnSync(process.execPath, [resolve('tests/registration-seed.mjs'), dbFile], {
      encoding: 'utf8'
    })
    if (seeded.status !== 0) throw new Error(seeded.stderr)
    const login = await call('POST', '/auth/login', {
      email: 'owner@example.com',
      password: 'secret1'
    })
    check(
      'existing account can still sign in with registration closed',
      login.status === 200 && Boolean(login.data.token)
    )
    state.token = login.data.token
    check(
      'existing account can read its profile',
      (await call('GET', '/api/profile')).status === 200
    )
  },
  { ALLOW_REGISTRATION: 'false' }
)

await withServer(
  'registration-open',
  async ctx => {
    const { call, check } = ctx
    check(
      'registration is enabled by default',
      (await call('GET', '/auth/config')).data.registrationEnabled === true
    )
    check(
      'default registration permits preparing an account',
      (
        await call('POST', '/auth/register', {
          name: 'Owner',
          email: 'owner@example.com',
          password: 'secret1'
        })
      ).status === 201
    )
  },
  { ALLOW_REGISTRATION: '' }
)
