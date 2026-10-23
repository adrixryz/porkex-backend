import { withServer } from './helpers.mjs'

// The default order is by the movement's own date (newest first), not by
// insertion order. The fixtures below are built so the two disagree: "E" is
// inserted last yet dated like the oldest entry, so it must come last.
await withServer('orders', async ({ call, check, state }) => {
  let r = await call('POST', '/auth/register', { name: 'T', email: 'o@o.com', password: 'secret1' })
  state.token = r.data.token
  await call('PUT', `/api/accounts/main-${r.data.user.id}`, { openingBalance: 1000000 })
  const cats = (await call('GET', '/api/categories')).data
  const expense = cats.find(c => c.type === 'EXPENSE')

  const old = '2023-01-10'
  const mid = '2024-06-10'
  // The first day of last month: always in the past, always after the other two.
  const now = new Date()
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const pad2 = n => String(n).padStart(2, '0')
  const recent = `${prev.getFullYear()}-${pad2(prev.getMonth() + 1)}-01`

  await call('POST', '/api/transactions', {
    amount: 10,
    type: 'EXPENSE',
    description: 'A - old date',
    categoryId: expense.id,
    date: old
  })
  await call('POST', '/api/transactions', {
    amount: 20,
    type: 'EXPENSE',
    description: 'B - mid date',
    categoryId: expense.id,
    date: mid
  })
  await call('POST', '/api/transactions', {
    amount: 30,
    type: 'EXPENSE',
    description: 'C - recent date',
    categoryId: expense.id,
    date: recent
  })
  await call('POST', '/api/transactions', {
    amount: 15,
    type: 'EXPENSE',
    description: 'E - old date inserted last',
    categoryId: expense.id,
    date: old
  })

  r = await call('GET', '/api/transactions')
  const order = r.data.items.map(i => i.description)
  check(
    'default ordena por fecha propia desc (C, B, E, A)',
    order.join(' | ') ===
      'C - recent date | B - mid date | E - old date inserted last | A - old date',
    order.join(' | ')
  )

  check('createdAt viene en la respuesta', !!r.data.items[0].createdAt, r.data.items[0].createdAt)

  r = await call('GET', '/api/dashboard')
  const dash = r.data.recentTransactions.map(i => i.description)
  check(
    'dashboard: recientes por fecha propia desc',
    dash.join(' | ') ===
      'C - recent date | B - mid date | E - old date inserted last | A - old date',
    dash.join(' | ')
  )

  r = await call('GET', '/api/transactions?sortBy=date&order=asc')
  check(
    'sortBy=date&order=asc (el id sigue el mismo orden y desempata)',
    r.data.items.map(i => i.description).join(' | ') ===
      'A - old date | E - old date inserted last | B - mid date | C - recent date',
    r.data.items.map(i => i.description).join(' | ')
  )

  r = await call('GET', '/api/transactions?sortBy=amount&order=desc')
  check(
    'sortBy=amount&order=desc',
    r.data.items.map(i => i.amount).join(',') === '30,20,15,10',
    r.data.items.map(i => i.amount).join(',')
  )

  r = await call('GET', '/api/transactions?sortBy=bogus')
  check(
    'sortBy inválido cae al default (fecha desc)',
    r.data.items[0].description === 'C - recent date',
    r.data.items[0].description
  )

  r = await call('POST', '/api/transactions', {
    amount: 40,
    type: 'EXPENSE',
    description: 'D - sin fecha',
    categoryId: expense.id
  })
  const utcDay = new Date().toISOString().slice(0, 10)
  r = await call('GET', '/api/transactions')
  check(
    'nuevo insertado (fecha de hoy) va primero',
    r.data.items[0].description === 'D - sin fecha',
    r.data.items[0].description
  )
  check(
    'sin fecha se guarda como el día de hoy (medianoche UTC)',
    r.data.items[0].date === `${utcDay}T00:00:00.000Z`,
    r.data.items[0].date
  )
  check(
    'sin fecha => createdAt = now',
    Math.abs(Date.now() - new Date(r.data.items[0].createdAt).getTime()) < 60000,
    r.data.items[0].createdAt
  )

  r = await call('PUT', `/api/transactions/${r.data.items[0].id}`, {
    amount: 40,
    type: 'EXPENSE',
    description: 'D - editada',
    categoryId: expense.id,
    date: recent
  })
  check(
    'PUT no altera createdAt',
    Math.abs(Date.now() - new Date(r.data.createdAt).getTime()) < 60000,
    r.data.createdAt
  )

  r = await call('GET', '/api/analytics?months=6&days=30')
  check(
    'analytics sigue aggregating por fecha propia',
    r.status === 200 && r.data.monthlyData.length === 6
  )
})
