import { withServer } from './helpers.mjs'

await withServer('paging', async ({ call, check, state, base }) => {
  const BASE = base

  let r = await call('POST', '/auth/register', { name: 'P', email: 'p@p.com', password: 'secret1' })
  state.token = r.data.token
  await call('PUT', `/api/accounts/main-${r.data.user.id}`, { openingBalance: 1000000 })
  const expense = (await call('GET', '/api/categories')).data.find(c => c.type === 'EXPENSE')

  for (let i = 1; i <= 5; i++) {
    await call('POST', '/api/transactions', {
      amount: i * 10,
      type: 'EXPENSE',
      description: `item ${i}`,
      categoryId: expense.id
    })
  }

  // ── page clampeada ──
  r = await call('GET', '/api/transactions?perPage=2&page=1')
  check(
    'pagina 1 de 2 por pagina',
    r.data.total === 5 && r.data.totalPages === 3 && r.data.items.length === 2,
    `total=${r.data.total} pages=${r.data.totalPages}`
  )

  r = await call('GET', '/api/transactions?perPage=2&page=99')
  check(
    'page=99 se clampea a la ultima',
    r.status === 200 && r.data.page === 3 && r.data.items.length === 1,
    `page=${r.data.page} items=${r.data.items.length}`
  )

  r = await call('GET', '/api/transactions?perPage=2&page=0')
  check(
    'page=0 se clampea a 1',
    r.data.page === 1 && r.data.items.length === 2,
    `page=${r.data.page}`
  )

  r = await call('GET', '/api/transactions?search=noexiste')
  check(
    'sin resultados: totalPages=1 y lista vacia',
    r.data.total === 0 && r.data.totalPages === 1 && r.data.items.length === 0,
    `total=${r.data.total} pages=${r.data.totalPages}`
  )

  r = await call('GET', '/api/transactions?search=noexiste&page=50')
  check('sin resultados con page=50 sigue en 1', r.data.page === 1, `page=${r.data.page}`)

  // ── min/max contradictorios ──
  r = await call('GET', '/api/transactions?min=100&max=10')
  check('min > max → 400', r.status === 400, r.data?.error)

  r = await call('GET', '/api/transactions?min=10&max=100')
  check(
    'min <= max → 200 con resultados',
    r.status === 200 && r.data.total === 5,
    `total=${r.data.total}`
  )

  r = await call('GET', '/api/transactions?min=30&max=30')
  check(
    'min == max sigue siendo valido',
    r.status === 200,
    `status=${r.status} total=${r.data.total}`
  )

  r = await call('GET', '/api/transactions?min=-5')
  check('min negativo → 400', r.status === 400, r.data?.error)

  // ── from/to contradictorios ──
  r = await call('GET', '/api/transactions?from=2024-06-01&to=2024-01-01')
  check('from > to → 400', r.status === 400, r.data?.error)

  r = await call('GET', '/api/transactions?from=2024-01-01&to=2024-01-31')
  check('from <= to → 200', r.status === 200, `status=${r.status}`)

  // ── el error handler global devuelve JSON, no HTML ──
  const badJson = await fetch(`${BASE}/api/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
    body: '{"amount": '
  })
  const text = await badJson.text()
  check('JSON malformado → 400, no 500', badJson.status === 400, `status=${badJson.status}`)
  check(
    'JSON malformado responde JSON',
    (badJson.headers.get('content-type') || '').includes('application/json'),
    badJson.headers.get('content-type') || 'sin header'
  )
  check(
    'el cuerpo es JSON con campo error',
    text.trim().startsWith('{') && text.includes('error'),
    text.slice(0, 80).replace(/\n/g, ' ')
  )

  const unknownAuthed = await fetch(`${BASE}/api/no-existe`, {
    headers: { Authorization: `Bearer ${state.token}` }
  })
  check(
    'ruta /api inexistente CON token → 404',
    unknownAuthed.status === 404,
    `status=${unknownAuthed.status}`
  )
  const unknownAnon = await fetch(`${BASE}/api/no-existe`)
  check(
    'ruta /api inexistente SIN token → 401',
    unknownAnon.status === 401,
    `status=${unknownAnon.status}`
  )
})
