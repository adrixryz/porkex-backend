import { withServer } from './helpers.mjs'

await withServer('currency', async ({ call, check, state }) => {
  let r = await call('POST', '/auth/register', {
    name: 'Ada',
    email: 'c@c.com',
    password: 'secret1'
  })
  check(
    'register devuelve currency por defecto',
    r.data.user.currency === 'USD',
    `currency=${r.data.user?.currency}`
  )
  state.token = r.data.token

  r = await call('GET', '/api/profile')
  check('GET /profile incluye currency', r.data.currency === 'USD', `currency=${r.data.currency}`)

  r = await call('PUT', '/api/profile', { currency: 'PEN' })
  check(
    'PUT currency PEN → 200',
    r.status === 200 && r.data.currency === 'PEN',
    JSON.stringify(r.data?.error || r.data.currency)
  )
  check('PUT solo currency no borra el nombre', r.data.name === 'Ada', `name=${r.data.name}`)

  r = await call('GET', '/api/profile')
  check('GET refleja la moneda guardada', r.data.currency === 'PEN', `currency=${r.data.currency}`)

  r = await call('PUT', '/api/profile', { currency: 'XXX' })
  check('codigo no soportado → 400', r.status === 400, r.data?.error)

  r = await call('PUT', '/api/profile', { currency: 'eur' })
  check('minusculas no se aceptan → 400', r.status === 400, r.data?.error)

  // La moneda debe viajar con la cuenta: login la devuelve.
  state.token = ''
  r = await call('POST', '/auth/login', { email: 'c@c.com', password: 'secret1' })
  check(
    'login devuelve la moneda de la cuenta',
    r.status === 200 && r.data.user.currency === 'PEN',
    `currency=${r.data.user?.currency}`
  )
  state.token = r.data.token

  r = await call('PUT', '/api/profile', { name: 'Ada Lovelace' })
  check(
    'PUT solo nombre conserva la moneda',
    r.status === 200 && r.data.currency === 'PEN' && r.data.name === 'Ada Lovelace',
    `${r.data.name} / ${r.data.currency}`
  )

  r = await call('PUT', '/api/profile', {})
  check('body vacio → 400', r.status === 400, r.data?.error)

  r = await call('PUT', '/api/profile', { name: '   ' })
  check('nombre en blanco → 400', r.status === 400, r.data?.error)

  r = await call('PUT', '/api/profile', { currency: 'EUR' })
  check(
    'los 7 codigos del front son validos',
    r.status === 200 && r.data.currency === 'EUR',
    r.data?.error || r.data.currency
  )
})
