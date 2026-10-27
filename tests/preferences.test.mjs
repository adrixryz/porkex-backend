// Display preferences stored on the account (default period, first day of the
// week, decimal separator): defaults, validation and the login round trip.
import { withServer } from './helpers.mjs'

await withServer('preferences', async ({ call, check, state }) => {
  let r = await call('POST', '/auth/register', {
    name: 'Prefs',
    email: 'p@p.com',
    password: 'secret1'
  })
  check(
    'register devuelve los defaults (week / MONDAY / .)',
    r.data.user.defaultPeriod === 'week' &&
      r.data.user.firstDayOfWeek === 'MONDAY' &&
      r.data.user.decimalSeparator === '.' &&
      r.data.user.language === 'en',
    JSON.stringify(r.data.user)
  )
  state.token = r.data.token

  r = await call('GET', '/api/profile')
  check(
    'GET /profile incluye las preferencias',
    r.data.defaultPeriod === 'week' &&
      r.data.firstDayOfWeek === 'MONDAY' &&
      r.data.decimalSeparator === '.' &&
      r.data.language === 'en',
    JSON.stringify(r.data)
  )

  r = await call('PUT', '/api/profile', {
    defaultPeriod: 'month',
    firstDayOfWeek: 'SUNDAY',
    decimalSeparator: ',',
    language: 'es'
  })
  check(
    'PUT guarda las tres preferencias',
    r.status === 200 &&
      r.data.defaultPeriod === 'month' &&
      r.data.firstDayOfWeek === 'SUNDAY' &&
      r.data.decimalSeparator === ',' &&
      r.data.language === 'es',
    JSON.stringify(r.data?.error || r.data)
  )
  check('PUT solo preferencias no borra el nombre', r.data.name === 'Prefs', r.data.name)

  r = await call('GET', '/api/profile')
  check(
    'GET refleja lo guardado',
    r.data.defaultPeriod === 'month' &&
      r.data.firstDayOfWeek === 'SUNDAY' &&
      r.data.decimalSeparator === ',' &&
      r.data.language === 'es'
  )

  // Each field is validated on its own.
  r = await call('PUT', '/api/profile', { defaultPeriod: 'ALL' })
  check('periodo no soportado → 400', r.status === 400, r.data?.error)
  r = await call('PUT', '/api/profile', { defaultPeriod: 'WEEK' })
  check('mayúsculas no se aceptan → 400', r.status === 400, r.data?.error)
  r = await call('PUT', '/api/profile', { firstDayOfWeek: 'sunday' })
  check('día en minúsculas → 400', r.status === 400, r.data?.error)
  r = await call('PUT', '/api/profile', { firstDayOfWeek: 'SUNDIAL' })
  check('día inventado → 400', r.status === 400, r.data?.error)
  r = await call('PUT', '/api/profile', { decimalSeparator: ';' })
  check('separador no soportado → 400', r.status === 400, r.data?.error)
  r = await call('PUT', '/api/profile', { language: 'fr' })
  check('idioma no soportado → 400', r.status === 400, r.data?.error)

  r = await call('GET', '/api/profile')
  check(
    'un 400 no toca lo guardado',
    r.data.defaultPeriod === 'month' &&
      r.data.firstDayOfWeek === 'SUNDAY' &&
      r.data.decimalSeparator === ',' &&
      r.data.language === 'es'
  )

  // Like the currency, the preferences travel with the account.
  state.token = ''
  r = await call('POST', '/auth/login', { email: 'p@p.com', password: 'secret1' })
  check(
    'login devuelve las preferencias de la cuenta',
    r.status === 200 &&
      r.data.user.defaultPeriod === 'month' &&
      r.data.user.firstDayOfWeek === 'SUNDAY' &&
      r.data.user.decimalSeparator === ',' &&
      r.data.user.language === 'es',
    JSON.stringify(r.data.user)
  )
  state.token = r.data.token
})
