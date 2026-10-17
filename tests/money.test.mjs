import { withServer } from './helpers.mjs'

// Amounts are stored as whole cents in an Int column. These checks lock that in:
// with the previous Float storage, 0.1 + 0.2 summed to 0.30000000000000004 and
// the budget maths drifted by a cent.
await withServer('money', async ({ call, check, state }) => {
  let r = await call('POST', '/auth/register', {
    name: 'Money',
    email: 'm@m.com',
    password: 'secret1'
  })
  check('registro', r.status === 201, JSON.stringify(r.data).slice(0, 60))
  state.token = r.data.token

  const cats = (await call('GET', '/api/categories')).data
  const food = cats.find(c => c.name === 'Food')
  const salary = cats.find(c => c.type === 'INCOME')

  // ── el caso clasico del punto flotante ──
  for (const amount of [0.1, 0.2]) {
    r = await call('POST', '/api/transactions', {
      amount,
      type: 'EXPENSE',
      description: `gasto ${amount}`,
      categoryId: food.id
    })
    check(`guarda ${amount} exacto`, r.data?.amount === amount, `recibido ${r.data?.amount}`)
  }

  r = await call('GET', '/api/categories')
  const foodCat = r.data.find(c => c.id === food.id)
  check('0.1 + 0.2 = 0.3 sin residuo', foodCat.total === 0.3, `total=${foodCat.total}`)

  r = await call('GET', '/api/dashboard')
  check(
    'el gasto total tambien cuadra',
    r.data.totalExpense === 0.3,
    `totalExpense=${r.data.totalExpense}`
  )

  // ── muchos importes con decimales que no son binarios ──
  for (const amount of [1.15, 2.35, 3.45, 4.55, 5.65]) {
    await call('POST', '/api/transactions', {
      amount,
      type: 'EXPENSE',
      description: `decimales ${amount}`,
      categoryId: food.id
    })
  }

  r = await call('GET', '/api/categories')
  const after = r.data.find(c => c.id === food.id)
  // 0.30 + 1.15 + 2.35 + 3.45 + 4.55 + 5.65 = 17.45
  check('la suma de 7 decimales es exacta', after.total === 17.45, `total=${after.total}`)

  // ── no se redondean silenciosamente importes con precisión excesiva ──
  r = await call('POST', '/api/transactions', {
    amount: 10.999,
    type: 'EXPENSE',
    description: 'redondeo',
    categoryId: food.id
  })
  check('rechaza más de 2 decimales', r.status === 400, r.data?.error)

  r = await call('POST', '/api/transactions', {
    amount: 0.001,
    type: 'EXPENSE',
    description: 'insignificante',
    categoryId: food.id
  })
  check('un importe inferior al céntimo se rechaza', r.status === 400, r.data?.error)

  // ── filtros por rango: comparan en centimos ──
  await call('POST', '/api/transactions', {
    amount: 100,
    type: 'INCOME',
    description: 'sueldo',
    categoryId: salary.id
  })

  r = await call('GET', '/api/transactions?min=1.15&max=4.55')
  check('rango con decimales exactos', r.data.total === 4, `total=${r.data.total}`)

  r = await call('GET', '/api/transactions?min=0.1&max=0.3')
  check('rango que incluye los dos decimales-small', r.data.total === 2, `total=${r.data.total}`)

  // ── orden por importe: los centimos ordenan mejor que los floats ──
  r = await call('GET', '/api/transactions?sortBy=amount&order=asc')
  const ascending = r.data.items.every((t, i, a) => i === 0 || a[i - 1].amount <= t.amount)
  check(
    'orden asc por importe consistente',
    ascending,
    JSON.stringify(r.data.items.map(t => t.amount))
  )

  // ── presupuesto: cuadrar exactamente al céntimo, en su propia categoria ──
  // Una categoria aparte para que el total sea solo lo que se registra aqui.
  r = await call('POST', '/api/categories', {
    name: 'Impuestos',
    type: 'EXPENSE',
    color: '#EA4335'
  })
  check('crear categoria de prueba', r.status === 201, r.data?.error)
  const taxes = r.data

  r = await call('POST', '/api/budgets', { categoryId: taxes.id, amount: 17.45, period: 'MONTH' })
  check(
    'crear presupuesto decimal → 201',
    r.status === 201 && r.data.amount === 17.45,
    r.data?.error || r.data?.amount
  )

  for (const amount of [7.45, 10]) {
    await call('POST', '/api/transactions', {
      amount,
      type: 'EXPENSE',
      description: `impuesto ${amount}`,
      categoryId: taxes.id
    })
  }

  r = await call('GET', '/api/budgets?period=MONTH')
  const b = r.data.budgets.find(x => x.categoryId === taxes.id)
  check(
    'gasto exactamente igual al limite',
    b.spent === 17.45 && b.remaining === 0,
    `spent=${b.spent} remaining=${b.remaining}`
  )
  check(
    'no marca superacion cuando cuadra al céntimo',
    b.overBudget === false,
    `overBudget=${b.overBudget}`
  )
  check('usagePercent exacto al 100%', b.usagePercent === 100, `pct=${b.usagePercent}`)

  const totals = r.data.totals.find(t => t.period === 'MONTH')
  check(
    'los totales cuadran al centimo',
    totals.spent === 17.45 && totals.amount === 17.45,
    JSON.stringify(totals)
  )

  // Un céntimo por encima ya debe marcar superacion: aqui esta el borde.
  await call('POST', '/api/transactions', {
    amount: 0.01,
    type: 'EXPENSE',
    description: 'un centimo',
    categoryId: taxes.id
  })
  r = await call('GET', '/api/budgets?period=MONTH')
  const over = r.data.budgets.find(x => x.categoryId === taxes.id)
  check(
    'un centimo de mas marca superacion',
    over.spent === 17.46 && over.overBudget === true && over.remaining === -0.01,
    `spent=${over.spent} over=${over.overBudget} remaining=${over.remaining}`
  )
})
