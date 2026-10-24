import { withServer } from './helpers.mjs'

// Caps on user-supplied strings and amounts, so a runaway payload cannot reach
// the database or be echoed back by a list query.
await withServer('limits', async ({ call, check, state }) => {
  let r = await call('POST', '/auth/register', {
    name: 'L',
    email: 'l@test.com',
    password: 'secret1'
  })
  state.token = r.data.token
  await call('PUT', `/api/accounts/main-${r.data.user.id}`, { openingBalance: 10000000 })
  const cats = (await call('GET', '/api/categories')).data
  const expense = cats.find(c => c.type === 'Expense')
  await call('POST', '/api/transactions', {
    amount: 10,
    type: 'Income',
    categoryId: cats.find(c => c.type === 'Income').id
  })

  // ── transactions ──
  r = await call('POST', '/api/transactions', {
    amount: 10,
    type: 'Expense',
    description: 'x'.repeat(201),
    categoryId: expense.id
  })
  check('descripcion > 200 → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/api/transactions', {
    amount: 10,
    type: 'Expense',
    description: 'ok',
    categoryId: expense.id
  })
  check('descripcion normal → 201', r.status === 201, r.data?.error)

  r = await call('POST', '/api/transactions', {
    amount: 10_000_001,
    type: 'Expense',
    description: 'enorme',
    categoryId: expense.id
  })
  check('monto > 10 millones → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/api/transactions', {
    amount: 10_000_000,
    type: 'Expense',
    description: 'al limite',
    categoryId: expense.id
  })
  check(
    'monto = 10 millones → 201',
    r.status === 201 && r.data.amount === 10_000_000,
    JSON.stringify(r.data?.error || r.data.amount)
  )

  r = await call('GET', `/api/transactions?search=${'y'.repeat(101)}`)
  check('busqueda > 100 → 400', r.status === 400, r.data?.error)

  r = await call('GET', '/api/transactions?min=10000001')
  check('filtro min > 10 millones → 400', r.status === 400, r.data?.error)

  // ── categories ──
  r = await call('POST', '/api/categories', { name: 'z'.repeat(61), type: 'Expense' })
  check('nombre de categoria > 60 → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/api/categories', { name: 'Color malo', type: 'Expense', color: 'rojo' })
  check('color no-hex → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/api/categories', { name: 'Color corto', type: 'Expense', color: '#abc' })
  check('color #abc (3 digitos) → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/api/categories', {
    name: 'Color bueno',
    type: 'Expense',
    color: '#A1B2C3'
  })
  check(
    'color #RRGGBB → 201',
    r.status === 201 && r.data.color === '#A1B2C3',
    JSON.stringify(r.data?.error || r.data.color)
  )

  // ── budgets ──
  r = await call('POST', '/api/budgets', {
    categoryId: expense.id,
    amount: 10_000_001,
    period: 'MONTH'
  })
  check('presupuesto > 10 millones → 400', r.status === 400, r.data?.error)

  // ── profile ──
  r = await call('PUT', '/api/profile', { name: 'w'.repeat(81) })
  check('nombre de perfil > 80 → 400', r.status === 400, r.data?.error)
})
