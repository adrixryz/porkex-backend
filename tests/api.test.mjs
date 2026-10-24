import { withServer } from './helpers.mjs'

// A transaction's `date` is a calendar day: the client sends 'YYYY-MM-DD' and
// the server stores UTC midnight of that day. These checks pin that model.
const utcDay = () => new Date().toISOString().slice(0, 10)

await withServer('api', async ({ call, check, state }) => {
  // 1.1 · date en transacciones
  let r = await call('POST', '/auth/register', {
    name: 'Test',
    email: 't@t.com',
    password: 'secret1'
  })
  check('register', r.status === 201 && !!r.data.token, JSON.stringify(r.data).slice(0, 80))
  state.token = r.data.token
  await call('PUT', `/api/accounts/main-${r.data.user.id}`, { openingBalance: 1000000 })

  const cats = (await call('GET', '/api/categories')).data
  check('categorías sembradas', cats.length === 9, `${cats.length}`)
  check(
    'categorías con contadores y sin _count',
    cats.every(
      c => 'transactionCount' in c && 'total' in c && 'budgetCount' in c && !('_count' in c)
    ),
    JSON.stringify(cats[0])
  )

  const expenseCat = cats.find(c => c.type === 'Expense')
  const incomeCat = cats.find(c => c.type === 'Income')

  r = await call('POST', '/api/transactions', {
    amount: 42.5,
    type: 'Expense',
    description: 'Alquiler enero',
    categoryId: expenseCat.id,
    date: '2024-01-15'
  })
  check(
    '1.1 POST acepta date y guarda medianoche UTC',
    r.status === 201 && r.data.date === '2024-01-15T00:00:00.000Z',
    r.data?.date
  )

  r = await call('POST', '/api/transactions', {
    amount: 10,
    type: 'Expense',
    description: 'sin fecha',
    categoryId: expenseCat.id
  })
  check(
    '1.1 POST sin date usa el día de hoy (UTC)',
    r.status === 201 && r.data.date === `${utcDay()}T00:00:00.000Z`,
    r.data?.date
  )

  r = await call('POST', '/api/transactions', {
    amount: 10,
    type: 'Expense',
    description: 'fecha mala',
    categoryId: expenseCat.id,
    date: 'no-es-fecha'
  })
  check('1.1 POST date inválida → 400', r.status === 400, r.data?.error)

  const future = new Date()
  future.setFullYear(future.getFullYear() + 3)
  r = await call('POST', '/api/transactions', {
    amount: 10,
    type: 'Expense',
    description: 'lejano',
    categoryId: expenseCat.id,
    date: future.toISOString()
  })
  check('1.1 POST >1 año futuro → 400', r.status === 400, r.data?.error)

  const txId = (await call('GET', '/api/transactions?search=Alquiler')).data.items[0].id
  r = await call('PUT', `/api/transactions/${txId}`, {
    amount: 42.5,
    type: 'Expense',
    description: 'Alquiler enero',
    categoryId: expenseCat.id,
    date: '2023-06-02'
  })
  check(
    '1.1 PUT actualiza date',
    r.status === 200 && new Date(r.data.date).getUTCMonth() === 5,
    r.data?.date
  )

  r = await call('PUT', `/api/transactions/${txId}`, {
    amount: 42.5,
    type: 'Expense',
    description: 'Alquiler enero',
    categoryId: expenseCat.id
  })
  check(
    '1.1 PUT sin date conserva la actual',
    r.status === 200 && new Date(r.data.date).getUTCMonth() === 5,
    r.data?.date
  )

  // 1.3 · contador real
  r = await call('GET', '/api/dashboard')
  check(
    '1.3 transactionCount real',
    r.status === 200 && r.data.transactionCount === 2,
    `count=${r.data.transactionCount}`
  )

  // 3 · filtros, orden y paginación
  await call('POST', '/api/transactions', {
    amount: 900,
    type: 'Income',
    description: 'Sueldo',
    categoryId: incomeCat.id
  })
  await call('POST', '/api/transactions', {
    amount: 7.25,
    type: 'Expense',
    description: 'Café con Marta',
    categoryId: expenseCat.id
  })
  await call('POST', '/api/transactions', {
    amount: 3.1,
    type: 'Expense',
    description: 'Panadería',
    categoryId: expenseCat.id
  })

  r = await call('GET', '/api/transactions?page=1&perPage=2')
  check(
    '3 paginación devuelve 2 items',
    r.data.items.length === 2 && r.data.perPage === 2 && r.data.page === 1
  )
  check(
    '3 total y totalPages correctos',
    r.data.total === 5 && r.data.totalPages === 3,
    `total=${r.data.total} pages=${r.data.totalPages}`
  )

  r = await call('GET', '/api/transactions?sortBy=amount&order=desc&perPage=3')
  check(
    '3 orden por monto desc',
    r.data.items.map(i => i.amount).join(',') === '900,42.5,10',
    r.data.items.map(i => i.amount).join(',')
  )

  r = await call('GET', '/api/transactions?search=café')
  check(
    '3 búsqueda por descripción (case-insensitive)',
    r.data.total === 1 && r.data.items[0].description === 'Café con Marta',
    JSON.stringify(r.data.total)
  )

  r = await call('GET', '/api/transactions?type=INCOME')
  check('3 filtro por tipo', r.data.total === 1 && r.data.items[0].type === 'Income')

  r = await call('GET', `/api/transactions?categoryId=${expenseCat.id}`)
  check('3 filtro por categoría', r.data.total === 4, `total=${r.data.total}`)

  r = await call('GET', '/api/transactions?min=10&max=100')
  check(
    '3 filtro por rango de monto',
    r.data.total === 2 &&
      r.data.items
        .map(i => i.amount)
        .sort((a, b) => a - b)
        .join(',') === '10,42.5',
    `total=${r.data.total} [${r.data.items.map(i => i.amount)}]`
  )

  r = await call('GET', '/api/transactions?page=99&perPage=2')
  check(
    '3 página fuera de rango se clampea a la última',
    r.status === 200 && r.data.page === r.data.totalPages && r.data.items.length > 0,
    `page=${r.data.page}/${r.data.totalPages} items=${r.data.items.length}`
  )

  r = await call('GET', '/api/transactions?type=BOGUS')
  check('3 type inválido → 400', r.status === 400, r.data?.error)

  // 'YYYY-MM-DD' covers that whole day, so it can be used directly in the URL.
  r = await call('GET', '/api/transactions?from=2024-01-01')
  check(
    '3 filtro por rango de fechas (2023-06 excluido)',
    r.data.total === 4,
    `total=${r.data.total}`
  )

  r = await call('GET', '/api/transactions?from=2024-06-01&to=2024-01-01')
  check('3 rango invertido → 400', r.status === 400, r.data?.error)

  // 4 · totales por categoría y reasignación
  r = await call('GET', `/api/categories?from=2024-01-01`)
  const catRow = r.data.find(c => c.id === expenseCat.id)
  check(
    '4 total y nº de movimientos en rango',
    r.status === 200 && catRow.total === 20.35 && catRow.transactionCount === 3,
    `total=${catRow?.total} count=${catRow?.transactionCount}`
  )

  const nCats = r.data.length
  r = await call('DELETE', `/api/categories/${expenseCat.id}`)
  check(
    '4 borrar categoría con movimientos → 409',
    r.status === 409 && r.data.needsReassignment === true,
    JSON.stringify(r.data)
  )

  const target = (await call('GET', '/api/categories')).data.find(
    c => c.type === 'Expense' && c.id !== expenseCat.id
  )
  const incomeTarget = (await call('GET', '/api/categories')).data.find(c => c.type === 'Income')

  r = await call('DELETE', `/api/categories/${expenseCat.id}?reassignTo=${incomeTarget.id}`)
  check('4 reasignar a categoría de otro tipo → 400', r.status === 400, r.data?.error)

  r = await call('DELETE', `/api/categories/${expenseCat.id}?reassignTo=${expenseCat.id}`)
  check('4 reasignar a sí misma → 400', r.status === 400, r.data?.error)

  r = await call('DELETE', `/api/categories/${expenseCat.id}?reassignTo=${target.id}`)
  check(
    '4 DELETE con reassignTo → 200',
    r.status === 200 && r.data.moved === 4,
    JSON.stringify(r.data)
  )

  r = await call('GET', '/api/categories')
  check('4 categoría eliminada', r.data.length === nCats - 1, `${r.data.length}`)

  r = await call('GET', `/api/transactions?categoryId=${target.id}`)
  check('4 movimientos reasignados', r.data.total === 4, `total=${r.data.total}`)

  // 2 · analytics
  r = await call('GET', '/api/analytics?months=3&days=30')
  const a = r.data
  check(
    '2 analytics months=3',
    r.status === 200 && a.monthlyData.length === 3 && a.range.months === 3
  )
  check('2 trend de 30 días', a.trendData.length === 30, `${a.trendData.length}`)
  check(
    '2 media móvil de 3 meses',
    typeof a.monthlyData[2].avgExpense === 'number' &&
      typeof a.monthlyData[0].avgExpense === 'number',
    JSON.stringify(a.monthlyData.map(m => m.avgExpense))
  )
  check('2 net por mes', typeof a.monthlyData[0].net === 'number')
  check(
    '2 insight avgDailyExpense',
    typeof a.insights.avgDailyExpense === 'number',
    `${a.insights.avgDailyExpense}`
  )
  check(
    '2 insight savingsRate',
    typeof a.insights.savingsRate === 'number',
    `${a.insights.savingsRate}`
  )
  check(
    '2 top categorías',
    Array.isArray(a.topCategories) &&
      a.topCategories.length > 0 &&
      typeof a.topCategories[0].percent === 'number',
    JSON.stringify(a.topCategories)
  )
  check(
    '2 comparativa de categorías',
    Array.isArray(a.categoryComparison) && a.categoryComparison.length > 0,
    JSON.stringify(a.categoryComparison.slice(0, 2))
  )

  r = await call('GET', '/api/analytics?months=12&days=90')
  check(
    '2 analytics months=12 days=90',
    r.data.monthlyData.length === 12 && r.data.trendData.length === 90
  )
  check(
    '2 balance trend creciente con ingresos',
    r.data.trendData[r.data.trendData.length - 1].balance > r.data.trendData[0].balance,
    `${r.data.trendData[0].balance} → ${r.data.trendData[r.data.trendData.length - 1].balance}`
  )

  r = await call('GET', '/api/analytics?months=7&days=45')
  check(
    '2 analytics rango libre months=7 days=45',
    r.data.monthlyData.length === 7 &&
      r.data.trendData.length === 45 &&
      r.data.range.months === 7 &&
      r.data.range.days === 45,
    JSON.stringify(r.data.range)
  )

  r = await call('GET', '/api/analytics?months=12&days=120')
  check(
    '2 analytics límites months=12 days=120',
    r.data.range.months === 12 && r.data.range.days === 120,
    JSON.stringify(r.data.range)
  )

  r = await call('GET', '/api/analytics?months=2&days=6')
  check(
    '2 analytics bajo el mínimo → defaults',
    r.data.range.months === 6 && r.data.range.days === 30,
    JSON.stringify(r.data.range)
  )

  r = await call('GET', '/api/analytics?months=99&days=abc')
  check(
    '2 params inválidos → defaults',
    r.data.range.months === 6 && r.data.range.days === 30,
    JSON.stringify(r.data.range)
  )

  r = await call('GET', '/api/analytics?today=ayer')
  check('2 today inválido → 400', r.status === 400, r.data?.error)
})
