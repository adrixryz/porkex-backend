
import { withServer } from './helpers.mjs'
const iso = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).toISOString()

await withServer('future-dates', async ({ call, check, results, state }) => {

  let r = await call('POST', '/auth/register', { name: 'F', email: 'f@f.com', password: 'secret1' })
  state.token = r.data.token
  const cats = (await call('GET', '/api/categories')).data
  const expense = cats.find(c => c.type === 'EXPENSE')
  const income = cats.find(c => c.type === 'INCOME')

  const today = new Date()
  const y = today.getFullYear(), m = today.getMonth() + 1, day = today.getDate()

  // â”€â”€ fechas futuras â”€â”€
  r = await call('POST', '/api/transactions', { amount: 10, type: 'EXPENSE', description: 'hoy', categoryId: expense.id, date: iso(y, m, day) })
  check('hoy se acepta', r.status === 201, r.data?.error)

  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
  r = await call('POST', '/api/transactions', { amount: 10, type: 'EXPENSE', description: 'manana', categoryId: expense.id, date: tomorrow.toISOString() })
  check('manana â†’ 400', r.status === 400, r.data?.error)
  check('el mensaje explica el motivo', r.data?.error === 'Date cannot be in the future.', r.data?.error)

  const in2days = new Date(today); in2days.setDate(in2days.getDate() + 2)
  r = await call('POST', '/api/transactions', { amount: 10, type: 'EXPENSE', description: 'dentro de 2 dias', categoryId: expense.id, date: in2days.toISOString() })
  check('dentro de 2 dias â†’ 400 (es futuro)', r.status === 400, r.data?.error)

  // Note: any time TODAY is accepted, not just the past hours.
  const earlierToday = new Date(today); earlierToday.setHours(0, 5, 0, 0)
  r = await call('POST', '/api/transactions', { amount: 10, type: 'EXPENSE', description: 'hoy madrugada', categoryId: expense.id, date: earlierToday.toISOString() })
  check('hoy a las 00:05 â†’ 201', r.status === 201, r.data?.error)

  r = await call('PUT', `/api/transactions/1`, { amount: 10, type: 'EXPENSE', description: 'hoy', categoryId: expense.id, date: iso(y, m, day) })
  check('PUT con fecha de hoy sigue permitido', r.status === 200, r.data?.error)

  // â”€â”€ el saldo de la analÃ­tica cuadra con el total real â”€â”€
  const lastMonth = new Date(today); lastMonth.setMonth(lastMonth.getMonth() - 1)
  await call('POST', '/api/transactions', { amount: 100, type: 'INCOME', description: 'sueldo viejo', categoryId: income.id, date: iso(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 10) })
  await call('POST', '/api/transactions', { amount: 40, type: 'EXPENSE', description: 'gasto viejo', categoryId: expense.id, date: iso(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 12) })
  await call('POST', '/api/transactions', { amount: 10, type: 'EXPENSE', description: 'gasto de hoy', categoryId: expense.id, date: iso(y, m, day) })

  r = await call('GET', '/api/analytics?months=3&days=30')
  const a = r.data
  const trend = a.trendData
  const last = trend[trend.length - 1].balance

  // Movimientos realmente guardados (los futuros se rechazaron):
  //   hoy 10 + hoy madrugada 10 + gasto de hoy 10 + gasto viejo 40 + sueldo viejo 100
  // Saldo real = 100 - 70 = 30
  check('el ultimo punto de la tendencia es el saldo real', Math.abs(last - 30) < 0.01, `balance=${last} (esperado 30)`)
  check('la tendencia tiene 30 puntos', trend.length === 30, `${trend.length}`)

  const currentMonth = a.monthlyData[a.monthlyData.length - 1]
  check('el mes actual recoge los 3 gastos de hoy', currentMonth.expense === 30, `expense=${currentMonth.expense}`)
  const prevMonth = a.monthlyData[a.monthlyData.length - 2]
  check('el mes anterior recoge gasto e ingreso', prevMonth.expense === 40 && prevMonth.income === 100, `${prevMonth.income}/${prevMonth.expense}`)

  // El endpoint de listado solo trae la ventana, pero el saldo debe ser completo.
  check('insights.avgDailyExpense numerico', typeof a.insights.avgDailyExpense === 'number', `${a.insights.avgDailyExpense}`)
  check('monthlyData con 3 puntos', a.monthlyData.length === 3, `${a.monthlyData.length}`)

  // â”€â”€ dashboard coherente â”€â”€
  r = await call('GET', '/api/dashboard')
  const expected = 100 - 40 - 30
  check('el dashboard cuadra con la analitica', Math.abs(r.data.globalBalance - expected) < 0.01, `globalBalance=${r.data.globalBalance} (esperado ${expected})`)
  check('dashboard cuenta 5 movimientos', r.data.transactionCount === 5, `count=${r.data.transactionCount}`)

  console.log('\n' + results.join('\n'))
})


