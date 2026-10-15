
import { withServer } from './helpers.mjs'

const iso = d => d.toISOString()

await withServer('api', async ({ call, check, results, state }) => {

  // 1.1 Â· date en transacciones
  let r = await call('POST', '/auth/register', { name: 'Test', email: 't@t.com', password: 'secret1' })
  check('register', r.status === 201 && !!r.data.token, JSON.stringify(r.data).slice(0, 80))
  state.token = r.data.token

  const cats = (await call('GET', '/api/categories')).data
  check('categorÃ­as sembradas', cats.length === 8, `${cats.length}`)
  check('categorÃ­as con contadores', cats.every(c => 'transactionCount' in c && 'total' in c), JSON.stringify(cats[0]))

  const expenseCat = cats.find(c => c.type === 'EXPENSE')
  const incomeCat = cats.find(c => c.type === 'INCOME')

  const past = new Date(2024, 0, 15, 12, 0, 0)
  r = await call('POST', '/api/transactions', {
    amount: 42.5, type: 'EXPENSE', description: 'Alquiler enero', categoryId: expenseCat.id, date: iso(past)
  })
  check('1.1 POST acepta date', r.status === 201 && new Date(r.data.date).getFullYear() === 2024, r.data?.date)

  r = await call('POST', '/api/transactions', {
    amount: 10, type: 'EXPENSE', description: 'sin fecha', categoryId: expenseCat.id
  })
  check('1.1 POST sin date usa now()', r.status === 201 && Math.abs(Date.now() - new Date(r.data.date).getTime()) < 60000, r.data?.date)

  r = await call('POST', '/api/transactions', {
    amount: 10, type: 'EXPENSE', description: 'fecha mala', categoryId: expenseCat.id, date: 'no-es-fecha'
  })
  check('1.1 POST date invÃ¡lida â†’ 400', r.status === 400, r.data?.error)

  const future = new Date(); future.setFullYear(future.getFullYear() + 3)
  r = await call('POST', '/api/transactions', {
    amount: 10, type: 'EXPENSE', description: 'lejano', categoryId: expenseCat.id, date: iso(future)
  })
  check('1.1 POST >1 aÃ±o futuro â†’ 400', r.status === 400, r.data?.error)

  const txId = (await call('GET', '/api/transactions?search=Alquiler')).data.items[0].id
  const newDate = new Date(2023, 5, 2, 10, 0, 0)
  r = await call('PUT', `/api/transactions/${txId}`, {
    amount: 42.5, type: 'EXPENSE', description: 'Alquiler enero', categoryId: expenseCat.id, date: iso(newDate)
  })
  check('1.1 PUT actualiza date', r.status === 200 && new Date(r.data.date).getMonth() === 5, r.data?.date)

  r = await call('PUT', `/api/transactions/${txId}`, {
    amount: 42.5, type: 'EXPENSE', description: 'Alquiler enero', categoryId: expenseCat.id
  })
  check('1.1 PUT sin date conserva la actual', r.status === 200 && new Date(r.data.date).getMonth() === 5, r.data?.date)

  // 1.3 Â· contador real
  r = await call('GET', '/api/dashboard')
  check('1.3 transactionCount real', r.status === 200 && r.data.transactionCount === 2, `count=${r.data.transactionCount}`)

  // 3 Â· filtros, orden y paginaciÃ³n
  await call('POST', '/api/transactions', { amount: 900, type: 'INCOME', description: 'Sueldo', categoryId: incomeCat.id })
  await call('POST', '/api/transactions', { amount: 7.25, type: 'EXPENSE', description: 'CafÃ© con Marta', categoryId: expenseCat.id })
  await call('POST', '/api/transactions', { amount: 3.1, type: 'EXPENSE', description: 'PanaderÃ­a', categoryId: expenseCat.id })

  r = await call('GET', '/api/transactions?page=1&perPage=2')
  check('3 paginaciÃ³n devuelve 2 items', r.data.items.length === 2 && r.data.perPage === 2 && r.data.page === 1)
  check('3 total y totalPages correctos', r.data.total === 5 && r.data.totalPages === 3, `total=${r.data.total} pages=${r.data.totalPages}`)

  r = await call('GET', '/api/transactions?sortBy=amount&order=desc&perPage=3')
  check('3 orden por monto desc', r.data.items.map(i => i.amount).join(',') === '900,42.5,10', r.data.items.map(i => i.amount).join(','))

  r = await call('GET', '/api/transactions?search=cafÃ©')
  check('3 bÃºsqueda por descripciÃ³n (case-insensitive)', r.data.total === 1 && r.data.items[0].description === 'CafÃ© con Marta', JSON.stringify(r.data.total))

  r = await call('GET', '/api/transactions?type=INCOME')
  check('3 filtro por tipo', r.data.total === 1 && r.data.items[0].type === 'INCOME')

  r = await call('GET', `/api/transactions?categoryId=${expenseCat.id}`)
  check('3 filtro por categorÃ­a', r.data.total === 4, `total=${r.data.total}`)

  r = await call('GET', '/api/transactions?min=10&max=100')
  check('3 filtro por rango de monto', r.data.total === 2 && r.data.items.map(i => i.amount).sort((a, b) => a - b).join(',') === '10,42.5', `total=${r.data.total} [${r.data.items.map(i => i.amount)}]`)

  r = await call('GET', '/api/transactions?page=99&perPage=2')
  check('3 pÃ¡gina fuera de rango se clampea a la Ãºltima', r.status === 200 && r.data.page === r.data.totalPages && r.data.items.length > 0, `page=${r.data.page}/${r.data.totalPages} items=${r.data.items.length}`)

  r = await call('GET', '/api/transactions?type=BOGUS')
  check('3 type invÃ¡lido â†’ 400', r.status === 400, r.data?.error)

  const from2024 = new Date(2024, 0, 1).toISOString()
  r = await call('GET', `/api/transactions?from=${encodeURIComponent(from2024)}`)
  check('3 filtro por rango de fechas (2023-06 excluido)', r.data.total === 4, `total=${r.data.total}`)

  // 4 Â· totales por categorÃ­a y reasignaciÃ³n
  r = await call('GET', `/api/categories?from=${encodeURIComponent(from2024)}`)
  const catRow = r.data.find(c => c.id === expenseCat.id)
  check('4 total y nÂº de movimientos en rango', r.status === 200 && catRow.total === 20.35 && catRow.transactionCount === 3, `total=${catRow?.total} count=${catRow?.transactionCount}`)

  const nCats = r.data.length
  r = await call('DELETE', `/api/categories/${expenseCat.id}`)
  check('4 borrar categorÃ­a con movimientos â†’ 409', r.status === 409 && r.data.needsReassignment === true, JSON.stringify(r.data))

  const target = (await call('GET', '/api/categories')).data.find(c => c.type === 'EXPENSE' && c.id !== expenseCat.id)
  const incomeTarget = (await call('GET', '/api/categories')).data.find(c => c.type === 'INCOME')

  r = await call('DELETE', `/api/categories/${expenseCat.id}?reassignTo=${incomeTarget.id}`)
  check('4 reasignar a categorÃ­a de otro tipo â†’ 400', r.status === 400, r.data?.error)

  r = await call('DELETE', `/api/categories/${expenseCat.id}?reassignTo=${expenseCat.id}`)
  check('4 reasignar a sÃ­ misma â†’ 400', r.status === 400, r.data?.error)

  r = await call('DELETE', `/api/categories/${expenseCat.id}?reassignTo=${target.id}`)
  check('4 DELETE con reassignTo â†’ 200', r.status === 200 && r.data.moved === 4, JSON.stringify(r.data))

  r = await call('GET', '/api/categories')
  check('4 categorÃ­a eliminada', r.data.length === nCats - 1, `${r.data.length}`)

  r = await call('GET', `/api/transactions?categoryId=${target.id}`)
  check('4 movimientos reasignados', r.data.total === 4, `total=${r.data.total}`)

  const empty = r.data.items.length ? null : null
  void empty

  // 2 Â· analytics
  r = await call('GET', '/api/analytics?months=3&days=30')
  const a = r.data
  check('2 analytics months=3', r.status === 200 && a.monthlyData.length === 3 && a.range.months === 3)
  check('2 trend de 30 dÃ­as', a.trendData.length === 30, `${a.trendData.length}`)
  check('2 media mÃ³vil de 3 meses', typeof a.monthlyData[2].avgExpense === 'number' && typeof a.monthlyData[0].avgExpense === 'number', JSON.stringify(a.monthlyData.map(m => m.avgExpense)))
  check('2 net por mes', typeof a.monthlyData[0].net === 'number')
  check('2 insight avgDailyExpense', typeof a.insights.avgDailyExpense === 'number', `${a.insights.avgDailyExpense}`)
  check('2 insight savingsRate', typeof a.insights.savingsRate === 'number', `${a.insights.savingsRate}`)
  check('2 top categorÃ­as', Array.isArray(a.topCategories) && a.topCategories.length > 0 && typeof a.topCategories[0].percent === 'number', JSON.stringify(a.topCategories))
  check('2 comparativa de categorÃ­as', Array.isArray(a.categoryComparison) && a.categoryComparison.length > 0, JSON.stringify(a.categoryComparison.slice(0, 2)))

  r = await call('GET', '/api/analytics?months=12&days=90')
  check('2 analytics months=12 days=90', r.data.monthlyData.length === 12 && r.data.trendData.length === 90)
  check('2 balance trend creciente con ingresos', r.data.trendData[r.data.trendData.length - 1].balance > r.data.trendData[0].balance,
    `${r.data.trendData[0].balance} â†’ ${r.data.trendData[r.data.trendData.length - 1].balance}`)

  r = await call('GET', '/api/analytics?months=99&days=abc')
  check('2 params invÃ¡lidos â†’ defaults', r.data.range.months === 6 && r.data.range.days === 30, JSON.stringify(r.data.range))

  console.log('\n' + results.join('\n'))
})


