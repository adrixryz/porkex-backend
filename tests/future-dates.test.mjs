import { withServer } from './helpers.mjs'

// Dates are calendar days: the client sends 'YYYY-MM-DD' and the server stores
// UTC midnight of that day. The tests mirror that, using the local calendar day
// (what the browser would send).
const pad2 = n => String(n).padStart(2, '0')
const localDay = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

await withServer('future-dates', async ({ call, check, state }) => {
  let r = await call('POST', '/auth/register', { name: 'F', email: 'f@f.com', password: 'secret1' })
  state.token = r.data.token
  await call('PUT', `/api/accounts/main-${r.data.user.id}`, { openingBalance: 1000000 })
  const cats = (await call('GET', '/api/categories')).data
  const expense = cats.find(c => c.type === 'Expense')
  const income = cats.find(c => c.type === 'Income')

  const today = new Date()
  const todayDay = localDay(today)

  // ── fechas futuras ──
  r = await call('POST', '/api/transactions', {
    amount: 10,
    type: 'Expense',
    description: 'hoy',
    categoryId: expense.id,
    date: todayDay
  })
  check('hoy se acepta', r.status === 201, r.data?.error)
  check(
    'la fecha queda como medianoche UTC del día',
    r.data?.date === `${todayDay}T00:00:00.000Z`,
    r.data?.date
  )

  // The guard allows up to UTC today + 1 day so a client in any timezone fits;
  // +3 days is in the future everywhere.
  const in3days = new Date(today)
  in3days.setDate(in3days.getDate() + 3)
  r = await call('POST', '/api/transactions', {
    amount: 10,
    type: 'Expense',
    description: 'en 3 dias',
    categoryId: expense.id,
    date: localDay(in3days)
  })
  check('en 3 dias → 400', r.status === 400, r.data?.error)
  check(
    'el mensaje explica el motivo',
    r.data?.error === 'Date cannot be in the future.',
    r.data?.error
  )

  // A full ISO timestamp (an older queued write) still works, and is
  // normalized to the UTC calendar day it falls on.
  const earlierToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 5)
  r = await call('POST', '/api/transactions', {
    amount: 10,
    type: 'Expense',
    description: 'hoy mediodia',
    categoryId: expense.id,
    date: earlierToday.toISOString()
  })
  check('ISO de hoy → 201', r.status === 201, r.data?.error)
  check(
    'se normaliza a medianoche UTC',
    (r.data?.date || '').endsWith('T00:00:00.000Z'),
    r.data?.date
  )

  r = await call('PUT', '/api/transactions/1', {
    amount: 10,
    type: 'Expense',
    description: 'hoy',
    categoryId: expense.id,
    date: todayDay
  })
  check('PUT con fecha de hoy sigue permitido', r.status === 200, r.data?.error)

  // ── el saldo de la analítica cuadra con el total real ──
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 10)
  await call('POST', '/api/transactions', {
    amount: 100,
    type: 'Income',
    description: 'sueldo viejo',
    categoryId: income.id,
    date: localDay(lastMonth)
  })
  await call('POST', '/api/transactions', {
    amount: 40,
    type: 'Expense',
    description: 'gasto viejo',
    categoryId: expense.id,
    date: localDay(lastMonth)
  })
  await call('POST', '/api/transactions', {
    amount: 10,
    type: 'Expense',
    description: 'gasto de hoy',
    categoryId: expense.id,
    date: todayDay
  })

  // The client's own day anchors the windows (today=...).
  r = await call('GET', `/api/analytics?months=3&days=30&today=${todayDay}`)
  const a = r.data
  const trend = a.trendData
  const last = trend[trend.length - 1].balance

  // Movimientos realmente guardados (los futuros se rechazaron):
  //   hoy 10 + hoy mediodia 10 + gasto de hoy 10 + gasto viejo 40 + sueldo viejo 100
  // Saldo real = 100 - 70 = 30
  check(
    'el ultimo punto de la tendencia es el saldo real',
    Math.abs(last - 1000030) < 0.01,
    `balance=${last} (esperado 1000030)`
  )
  check('la tendencia tiene 30 puntos', trend.length === 30, `${trend.length}`)

  const currentMonth = a.monthlyData[a.monthlyData.length - 1]
  check(
    'el mes actual recoge los 3 gastos de hoy',
    currentMonth.expense === 30,
    `expense=${currentMonth.expense}`
  )
  const prevMonth = a.monthlyData[a.monthlyData.length - 2]
  check(
    'el mes anterior recoge gasto e ingreso',
    prevMonth.expense === 40 && prevMonth.income === 100,
    `${prevMonth.income}/${prevMonth.expense}`
  )

  check(
    'insights.avgDailyExpense numerico',
    typeof a.insights.avgDailyExpense === 'number',
    `${a.insights.avgDailyExpense}`
  )
  check('monthlyData con 3 puntos', a.monthlyData.length === 3, `${a.monthlyData.length}`)

  // ── dashboard coherente ──
  r = await call('GET', '/api/dashboard')
  const expected = 100 - 40 - 30
  check(
    'el dashboard cuadra con la analitica',
    Math.abs(r.data.globalBalance - 1000000 - expected) < 0.01,
    `globalBalance=${r.data.globalBalance} (esperado ${expected})`
  )
  check(
    'dashboard cuenta 5 movimientos',
    r.data.transactionCount === 5,
    `count=${r.data.transactionCount}`
  )
})
