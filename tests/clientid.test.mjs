import { withServer } from './helpers.mjs'

// The frontend queues writes that fail and replays them when the server comes
// back. A create whose response was lost in transit must therefore not land
// twice: the client sends a clientId and the server answers with the record
// it already created.
await withServer('clientid', async ({ call, check, state }) => {
  let r = await call('POST', '/auth/register', {
    name: 'Idem',
    email: 'i@i.com',
    password: 'secret1'
  })
  check('registro', r.status === 201, JSON.stringify(r.data).slice(0, 60))
  state.token = r.data.token
  await call('PUT', `/api/accounts/main-${r.data.user.id}`, { openingBalance: 1000000 })

  const cats = (await call('GET', '/api/categories')).data
  const food = cats.find(c => c.name === 'Food')

  const payload = {
    amount: 12.34,
    type: 'Expense',
    description: 'cafe idempotente',
    categoryId: food.id,
    clientId: 'abc-123_XYZ'
  }

  // ── first call creates ──
  r = await call('POST', '/api/transactions', payload)
  check('primer POST crea → 201', r.status === 201, `status=${r.status} ${r.data?.error || ''}`)
  const firstId = r.data.id

  // ── the replay returns the same row, not a new one ──
  r = await call('POST', '/api/transactions', payload)
  check('segundo POST → 200 (no recreado)', r.status === 200, `status=${r.status}`)
  check(
    'devuelve la misma transaccion',
    r.data.id === firstId,
    `id=${r.data.id} esperado=${firstId}`
  )
  check('el importe no cambia', r.data.amount === 12.34, `amount=${r.data.amount}`)

  // ── a third replay, plus an independent id, to be sure ──
  await call('POST', '/api/transactions', payload)
  await call('POST', '/api/transactions', { ...payload, clientId: 'otro-id-999' })

  r = await call('GET', '/api/transactions?search=idempotente')
  check('3 reintentos + 1 nuevo = 2 filas', r.data.total === 2, `total=${r.data.total}`)

  // ── without clientId nothing is deduped: the old behaviour ──
  r = await call('POST', '/api/transactions', {
    amount: 5,
    type: 'Expense',
    description: 'sin clientId',
    categoryId: food.id
  })
  check('POST sin clientId → 201', r.status === 201, `status=${r.status}`)
  check(
    'el clientId viene vacio',
    r.data.clientId === null,
    `clientId=${JSON.stringify(r.data.clientId)}`
  )

  r = await call('GET', '/api/transactions?search=sin clientId')
  check('varias filas con clientId NULL conviven', r.data.total === 1, `total=${r.data.total}`)

  // ── validation ──
  r = await call('POST', '/api/transactions', { ...payload, clientId: 'con espacios y simbolos!' })
  check('clientId invalido → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/api/transactions', { ...payload, clientId: 'x'.repeat(65) })
  check('clientId demasiado largo → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/api/transactions', { ...payload, clientId: '' })
  check(
    'clientId vacio se ignora, no es error',
    r.status === 201 || r.status === 200,
    `status=${r.status}`
  )

  // ── ownership: another user cannot claim or read someone else's id ──
  r = await call('POST', '/auth/register', { name: 'Otro', email: 'o@o.com', password: 'secret1' })
  state.token = r.data.token
  await call('PUT', `/api/accounts/main-${r.data.user.id}`, { openingBalance: 1000 })

  const otherCats = (await call('GET', '/api/categories')).data
  const otherFood = otherCats.find(c => c.name === 'Food')

  r = await call('POST', '/api/transactions', { ...payload, categoryId: otherFood.id })
  check('otro usuario con el mismo clientId → 201', r.status === 201, `status=${r.status}`)
  check('crea la suya propia, no devuelve la ajena', r.data.id !== firstId, `id=${r.data.id}`)
})
