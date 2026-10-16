import { withServer } from './helpers.mjs'

// Rango de "esta semana" (lunes a domingo) igual que el frontend: días de
// calendario locales que se envían como 'YYYY-MM-DD'.
const pad2 = n => String(n).padStart(2, '0')
const dayString = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const startOfWeek = () => {
  const d = new Date()
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}
const endOfWeek = () => {
  const d = startOfWeek()
  d.setDate(d.getDate() + 6)
  return d
}

await withServer('reassign', async ({ call, check, state }) => {
  let r = await call('POST', '/auth/register', { name: 'T', email: 'r@r.com', password: 'secret1' })
  state.token = r.data.token
  const seed = (await call('GET', '/api/categories')).data
  const target = seed.find(c => c.name === 'Food') // se usara como destino

  // Movimientos con fecha de hace 2 meses: fuera de "esta semana".
  const now = new Date()
  const old = new Date(now.getFullYear(), now.getMonth() - 2, 15)
  for (const amount of [10, 20, 30]) {
    await call('POST', '/api/transactions', {
      amount,
      type: 'EXPENSE',
      description: `old ${amount}`,
      categoryId: target.id,
      date: dayString(old)
    })
  }
  // Y uno de esta semana, para que el periodo no salga vacio.
  await call('POST', '/api/transactions', {
    amount: 5,
    type: 'EXPENSE',
    description: 'this week',
    categoryId: target.id,
    date: dayString(now)
  })

  const from = dayString(startOfWeek())
  const to = dayString(endOfWeek())

  r = await call('GET', `/api/categories?from=${from}&to=${to}`)
  const row = r.data.find(c => c.id === target.id)
  check(
    'transactionCount cuenta SOLO el periodo',
    row.transactionCount === 1,
    `transactionCount=${row.transactionCount}`
  )
  check('total usa el mismo periodo', row.total === 5, `total=${row.total}`)
  check(
    'allTimeCount cuenta todo el historico',
    row.allTimeCount === 4,
    `allTimeCount=${row.allTimeCount}`
  )

  // Con el periodo filtrado, la UI ve 1 movimiento -> creeria que se puede borrar.
  // El backend debe exigir destino y decirlo de forma utilizable.
  r = await call('DELETE', `/api/categories/${target.id}`)
  check('DELETE sin movimientos visibles aun devuelve 409', r.status === 409, `status=${r.status}`)
  check('409 trae needsReassignment', r.data.needsReassignment === true, JSON.stringify(r.data))
  check(
    '409 trae el conteo real',
    r.data.transactionCount === 4,
    `transactionCount=${r.data.transactionCount}`
  )

  r = await call('DELETE', `/api/categories/${target.id}?reassignTo=${target.id}`)
  check('reasignar a si misma → 400', r.status === 400, r.data?.error)

  const incomeCat = (await call('GET', '/api/categories')).data.find(c => c.type === 'INCOME')
  r = await call('DELETE', `/api/categories/${target.id}?reassignTo=${incomeCat.id}`)
  check('reasignar a categoria de otro tipo → 400', r.status === 400, r.data?.error)

  const dest = (await call('GET', '/api/categories')).data.find(
    c => c.type === 'EXPENSE' && c.id !== target.id
  )
  r = await call('DELETE', `/api/categories/${target.id}?reassignTo=${dest.id}`)
  check(
    'DELETE con reassignTo → 200 y mueve los 4',
    r.status === 200 && r.data.moved === 4,
    JSON.stringify(r.data)
  )

  r = await call('GET', `/api/transactions?categoryId=${dest.id}`)
  check('los 4 movimientos estan ahora en el destino', r.data.total === 4, `total=${r.data.total}`)

  r = await call('GET', '/api/categories')
  check('la categoria borrada ya no existe', !r.data.some(c => c.id === target.id))
  check(
    'el destino conserva su allTimeCount',
    r.data.find(c => c.id === dest.id).allTimeCount === 4
  )
})
