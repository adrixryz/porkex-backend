import { withServer } from './helpers.mjs'

// The /auth limiter only counts failed attempts (skipSuccessfulRequests), so a
// normal login never consumes the budget. With AUTH_RATE_LIMIT_MAX=5 the 429
// path can be reached in five wrong passwords instead of thirty.
await withServer(
  'ratelimit',
  async ({ call, check, state }) => {
    let r = await call('POST', '/auth/register', {
      name: 'R',
      email: 'r@test.com',
      password: 'secret1'
    })
    check('register (exitoso, no cuenta) → 201', r.status === 201, `status=${r.status}`)
    state.token = r.data.token

    // Five failed logins fill the budget (401 each), the sixth is blocked.
    for (let i = 1; i <= 5; i++) {
      r = await call('POST', '/auth/login', { email: 'r@test.com', password: `mala-${i}` })
      check(`intento fallido ${i} → 401`, r.status === 401, `status=${r.status}`)
    }

    r = await call('POST', '/auth/login', { email: 'r@test.com', password: 'mala-6' })
    check('6º intento fallido → 429', r.status === 429, `status=${r.status} ${r.data?.error || ''}`)
    check(
      'el 429 trae mensaje JSON',
      typeof r.data?.error === 'string' && r.data.error.length > 0,
      JSON.stringify(r.data)
    )

    // The general API limiter is untouched by auth failures: a valid token
    // still reads data.
    r = await call('GET', '/api/dashboard')
    check('la API normal sigue respondiendo', r.status === 200, `status=${r.status}`)
  },
  { AUTH_RATE_LIMIT_MAX: '5' }
)
