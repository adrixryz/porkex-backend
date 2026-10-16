import jwt from 'jsonwebtoken'
import { withServer } from './helpers.mjs'

// Registration/login behaviour, token handling, and the validation limits that
// guard the bcrypt hashing and the database columns.
await withServer('auth', async ({ call, check, state, base }) => {
  // ── register ──
  let r = await call('POST', '/auth/register', {
    name: 'Ana',
    email: 'ana@test.com',
    password: 'secret1'
  })
  check(
    'register → 201 con token y usuario',
    r.status === 201 && !!r.data.token && r.data.user.email === 'ana@test.com',
    JSON.stringify(r.data).slice(0, 80)
  )
  check('register normaliza el email a minusculas', r.data.user.email === 'ana@test.com')
  state.token = r.data.token

  const cats = (await call('GET', '/api/categories')).data
  check('register siembra las 8 categorias', cats.length === 8, `${cats.length}`)

  r = await call('POST', '/auth/register', {
    name: 'Ana',
    email: 'ana@test.com',
    password: 'secret1'
  })
  check('email duplicado → 409', r.status === 409, `status=${r.status} ${r.data?.error || ''}`)

  r = await call('POST', '/auth/register', { name: 'B', email: 'no-arroba', password: 'secret1' })
  check('email invalido → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/auth/register', { name: 'B', email: 'b@test.com', password: '123' })
  check('password corta → 400', r.status === 400, r.data?.error)

  // bcrypt silently truncates at 72 bytes; a longer password must be rejected
  // so two different strings can never open the same account.
  r = await call('POST', '/auth/register', {
    name: 'B',
    email: 'b@test.com',
    password: 'x'.repeat(73)
  })
  check('password > 72 bytes → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/auth/register', {
    name: 'x'.repeat(81),
    email: 'b@test.com',
    password: 'secret1'
  })
  check('nombre > 80 caracteres → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/auth/register', { email: 'b@test.com', password: 'secret1' })
  check('register sin nombre → 400', r.status === 400, r.data?.error)

  // ── login ──
  r = await call('POST', '/auth/login', { email: 'ana@test.com', password: 'secret1' })
  check('login → 200 con token', r.status === 200 && !!r.data.token, `status=${r.status}`)

  r = await call('POST', '/auth/login', { email: 'ANA@TEST.COM', password: 'secret1' })
  check('login acepta mayusculas en el email', r.status === 200, `status=${r.status}`)

  r = await call('POST', '/auth/login', { email: 'ana@test.com', password: 'wrong-pass' })
  check('password incorrecta → 401', r.status === 401, `status=${r.status}`)

  r = await call('POST', '/auth/login', { email: 'nadie@test.com', password: 'secret1' })
  check(
    'email desconocido → 401 con el mismo mensaje',
    r.status === 401 && r.data.error === 'Invalid email or password.',
    r.data?.error
  )

  r = await call('POST', '/auth/login', {})
  check('login sin datos → 400', r.status === 400, r.data?.error)

  // ── tokens ──
  state.token = ''
  r = await call('GET', '/api/dashboard')
  check('sin token → 401', r.status === 401, `status=${r.status}`)

  state.token = 'garbage'
  r = await call('GET', '/api/dashboard')
  check('token invalido → 401', r.status === 401, `status=${r.status}`)

  state.token = jwt.sign({ userId: 1 }, 'otro-secreto')
  r = await call('GET', '/api/dashboard')
  check('token firmado con otro secreto → 401', r.status === 401, `status=${r.status}`)

  const malformed = await fetch(`${base}/api/dashboard`, {
    headers: { Authorization: 'Token abc' }
  })
  check('header sin "Bearer " → 401', malformed.status === 401, `status=${malformed.status}`)

  // A valid token still works after all of the above.
  state.token = jwt.sign({ userId: 1 }, 'test-secret')
  r = await call('GET', '/api/dashboard')
  check('token valido → 200', r.status === 200, `status=${r.status}`)
})
