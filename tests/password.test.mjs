import { withServer, createTestUser } from './helpers.mjs'

// Password change: the one endpoint that could log you out by accident. A
// wrong current password must answer 400 (never 401), because the frontend
// treats a 401 as an expired session and redirects to the login screen.
await withServer('password', async ctx => {
  const { call, check } = ctx

  // Before registering: no token at all.
  let r = await call('PUT', '/api/password', { currentPassword: 'x', newPassword: 'yyyyyy' })
  check('sin token → 401', r.status === 401, `status=${r.status}`)

  await createTestUser(ctx)

  r = await call('PUT', '/api/password', { currentPassword: 'secret1' })
  check('falta la contraseña nueva → 400', r.status === 400, `status=${r.status}`)
  check(
    'mensaje de campos faltantes',
    r.data?.error === 'Current and new password are required.',
    JSON.stringify(r.data)
  )

  r = await call('PUT', '/api/password', { currentPassword: 'incorrecta', newPassword: 'nueva123' })
  check('actual incorrecta → 400 (no 401)', r.status === 400, `status=${r.status}`)
  check(
    'mensaje de actual incorrecta',
    r.data?.error === 'Current password is incorrect.',
    JSON.stringify(r.data)
  )

  r = await call('PUT', '/api/password', { currentPassword: 'secret1', newPassword: '123' })
  check('nueva demasiado corta → 400', r.status === 400, `status=${r.status}`)
  check(
    'mensaje de longitud mínima',
    r.data?.error === 'New password must be at least 6 characters.',
    JSON.stringify(r.data)
  )

  r = await call('PUT', '/api/password', {
    currentPassword: 'secret1',
    newPassword: 'a'.repeat(73)
  })
  check('nueva de más de 72 bytes → 400', r.status === 400, `status=${r.status}`)
  check(
    'mensaje de longitud máxima',
    r.data?.error === 'New password must be at most 72 bytes.',
    JSON.stringify(r.data)
  )

  // The failed attempts above must not have changed anything.
  r = await call('POST', '/auth/login', { email: 'test@example.com', password: 'secret1' })
  check(
    'la contraseña vieja sigue funcionando tras los intentos fallidos',
    r.status === 200,
    `status=${r.status}`
  )

  r = await call('PUT', '/api/password', { currentPassword: 'secret1', newPassword: 'nueva123' })
  check('cambio válido → 200', r.status === 200, `status=${r.status}`)
  check('respuesta { success: true }', r.data?.success === true, JSON.stringify(r.data))

  r = await call('GET', '/api/profile')
  check(
    'el token actual sigue siendo válido tras el cambio',
    r.status === 200,
    `status=${r.status}`
  )

  r = await call('POST', '/auth/login', { email: 'test@example.com', password: 'nueva123' })
  check('login con la nueva contraseña → 200', r.status === 200, `status=${r.status}`)

  r = await call('POST', '/auth/login', { email: 'test@example.com', password: 'secret1' })
  check('login con la vieja contraseña → 401', r.status === 401, `status=${r.status}`)
})
