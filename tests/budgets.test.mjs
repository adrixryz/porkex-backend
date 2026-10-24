import { withServer } from './helpers.mjs'

const pad2 = n => String(n).padStart(2, '0')
const dayString = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

await withServer('budgets', async ({ call, check, state }) => {
  // ── setup: user + one expense category ──
  let r = await call('POST', '/auth/register', {
    name: 'Budget',
    email: 'b@b.com',
    password: 'secret1'
  })
  check('registro', r.status === 201, JSON.stringify(r.data).slice(0, 60))
  state.token = r.data.token
  await call('PUT', `/api/accounts/main-${r.data.user.id}`, { openingBalance: 1000000 })

  const cats = (await call('GET', '/api/categories')).data
  const food = cats.find(c => c.name === 'Food')
  const housing = cats.find(c => c.name === 'Housing')
  const salary = cats.find(c => c.type === 'Income')

  // Spending that must count towards this month and this week.
  const today = new Date()
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 5)

  await call('POST', '/api/transactions', {
    amount: 30,
    type: 'Expense',
    description: 'supermercado',
    categoryId: food.id
  })
  await call('POST', '/api/transactions', {
    amount: 20,
    type: 'Expense',
    description: 'pan',
    categoryId: food.id
  })
  await call('POST', '/api/transactions', {
    amount: 500,
    type: 'Expense',
    description: 'alquiler viejo',
    categoryId: housing.id,
    date: dayString(lastMonth)
  })

  // ── empty state ──
  r = await call('GET', '/api/budgets')
  check(
    'sin presupuestos devuelve lista vacia y totales vacios',
    r.status === 200 && r.data.budgets.length === 0 && r.data.totals.length === 0,
    JSON.stringify(r.data.totals)
  )

  // ── create ──
  r = await call('POST', '/api/budgets', { categoryId: food.id, amount: 100, period: 'MONTH' })
  check(
    'crear presupuesto → 201',
    r.status === 201 && r.data.amount === 100,
    JSON.stringify(r.data?.error || r.data.amount)
  )
  check(
    'la respuesta incluye la categoria',
    r.data.category?.name === 'Food',
    r.data.category?.name
  )

  const budgetId = r.data.id

  r = await call('POST', '/api/budgets', { categoryId: food.id, amount: 50, period: 'MONTH' })
  check('duplicado misma categoria+periodo → 409', r.status === 409, r.data?.error)

  r = await call('POST', '/api/budgets', { categoryId: food.id, amount: 50, period: 'WEEK' })
  check('misma categoria con otro periodo → 201', r.status === 201, r.data?.error)

  r = await call('POST', '/api/budgets', { categoryId: food.id, amount: 0, period: 'MONTH' })
  check('importe 0 → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/api/budgets', { categoryId: food.id, amount: -5, period: 'MONTH' })
  check('importe negativo → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/api/budgets', { categoryId: food.id, amount: 100, period: 'YEAR' })
  check('periodo invalido → 400', r.status === 400, r.data?.error)

  r = await call('POST', '/api/budgets', { categoryId: 99999, amount: 100, period: 'MONTH' })
  check('categoria ajena → 404', r.status === 404, r.data?.error)

  r = await call('POST', '/api/budgets', { categoryId: salary.id, amount: 100, period: 'MONTH' })
  check('presupuesto en categoria de ingresos → 201', r.status === 201, r.data?.error)

  // ── spent computation ──
  r = await call('GET', '/api/budgets?period=MONTH')
  const monthly = r.data.budgets.find(b => b.id === budgetId)
  check('el gasto del mes se acumula (30+20 = 50)', monthly.spent === 50, `spent=${monthly?.spent}`)
  check('gasto del mes anterior NO cuenta', monthly.spent !== 530, `spent=${monthly?.spent}`)
  check('remaining = limite - gastado', monthly.remaining === 50, `remaining=${monthly?.remaining}`)
  check('usagePercent = 50%', monthly.usagePercent === 50, `pct=${monthly?.usagePercent}`)
  check('overBudget en false', monthly.overBudget === false)
  check(
    'incluye el nombre y color de la categoria',
    monthly.category?.name === 'Food' && !!monthly.category?.color,
    JSON.stringify(monthly.category)
  )

  r = await call('GET', '/api/budgets?period=WEEK')
  check(
    'el filtro por periodo devuelve solo ese periodo',
    r.data.budgets.every(b => b.period === 'WEEK'),
    JSON.stringify(r.data.budgets.map(b => b.period))
  )

  r = await call('GET', '/api/budgets')
  check(
    'sin filtro devuelve ambos periodos',
    r.data.budgets.length === 3,
    `n=${r.data.budgets.length}`
  )

  r = await call('GET', '/api/budgets?period=YEAR')
  check('periodo invalido en query → 400', r.status === 400, r.data?.error)

  // ── today ancla la ventana (el cliente manda su propio día) ──
  const lastWeek = new Date(today)
  lastWeek.setDate(lastWeek.getDate() - 7)
  r = await call('GET', `/api/budgets?period=WEEK&today=${dayString(lastWeek)}`)
  const shifted = r.data.budgets.find(b => b.period === 'WEEK' && b.categoryId === food.id)
  check(
    'today ancla la ventana semanal (semana pasada: spent 0)',
    shifted.spent === 0,
    `spent=${shifted?.spent}`
  )

  r = await call('GET', '/api/budgets?period=WEEK&today=hoy')
  check('today invalido → 400', r.status === 400, r.data?.error)

  // ── budgetCount en /categories, para el aviso al borrar ──
  r = await call('GET', '/api/categories')
  const foodRow = r.data.find(c => c.id === food.id)
  check(
    'budgetCount refleja los presupuestos de la categoria',
    foodRow.budgetCount === 2,
    `budgetCount=${foodRow?.budgetCount}`
  )

  // ── over budget ──
  r = await call('PUT', `/api/budgets/${budgetId}`, { amount: 40, period: 'MONTH' })
  check(
    'editar limite → 200',
    r.status === 200 && r.data.amount === 40,
    JSON.stringify(r.data?.error || r.data.amount)
  )

  r = await call('GET', '/api/budgets?period=MONTH')
  const over = r.data.budgets.find(b => b.id === budgetId)
  check(
    'detecta superacion del presupuesto',
    over.overBudget === true,
    `spent=${over.spent} limit=${over.amount}`
  )
  check('remaining negativo al superarse', over.remaining === -10, `remaining=${over.remaining}`)
  check('usagePercent sobre 100', over.usagePercent === 125, `pct=${over.usagePercent}`)

  r = await call('GET', '/api/budgets')
  check(
    'los totales marcan superacion',
    r.data.totals.some(t => t.overBudget),
    JSON.stringify(r.data.totals)
  )
  check(
    'los totales van por periodo (sin doble conteo)',
    r.data.totals.length === 2,
    JSON.stringify(r.data.totals)
  )
  const monthTotals = r.data.totals.find(t => t.period === 'MONTH')
  const weekTotals = r.data.totals.find(t => t.period === 'WEEK')
  check(
    'total mensual = 50 Food + 0 ingresos',
    monthTotals.spent === 50,
    `spent=${monthTotals.spent}`
  )
  check('total semanal calculado aparte', weekTotals.spent === 50, `spent=${weekTotals.spent}`)

  // ── update conflicts ──
  const weeklyBudget = (await call('GET', '/api/budgets?period=WEEK')).data.budgets[0]
  r = await call('PUT', `/api/budgets/${weeklyBudget.id}`, { amount: 10, period: 'MONTH' })
  check('mover a un periodo ya ocupado → 409', r.status === 409, r.data?.error)

  r = await call('PUT', '/api/budgets/99999', { amount: 10, period: 'MONTH' })
  check('editar id inexistente → 404', r.status === 404, r.data?.error)

  r = await call('PUT', `/api/budgets/${budgetId}`, { amount: 0, period: 'MONTH' })
  check('editar a importe 0 → 400', r.status === 400, r.data?.error)

  // ── ownership ──
  const saved = state.token
  state.token = ''
  r = await call('POST', '/auth/register', { name: 'Other', email: 'o@o.com', password: 'secret1' })
  state.token = r.data.token

  r = await call('GET', '/api/budgets')
  check(
    'otro usuario no ve presupuestos ajenos',
    r.data.budgets.length === 0,
    `n=${r.data.budgets.length}`
  )

  r = await call('PUT', `/api/budgets/${budgetId}`, { amount: 999, period: 'MONTH' })
  check('otro usuario no puede editar → 404', r.status === 404, r.data?.error)

  r = await call('DELETE', `/api/budgets/${budgetId}`)
  check('otro usuario no puede borrar → 404', r.status === 404, r.data?.error)

  // ── delete ──
  state.token = saved
  r = await call('DELETE', `/api/budgets/${budgetId}`)
  check(
    'borrar presupuesto → 200',
    r.status === 200 && r.data.success === true,
    JSON.stringify(r.data)
  )

  r = await call('GET', '/api/budgets')
  check(
    'el presupuesto ya no aparece',
    !r.data.budgets.some(b => b.id === budgetId),
    `n=${r.data.budgets.length}`
  )

  r = await call('DELETE', `/api/budgets/${budgetId}`)
  check('borrar dos veces → 404', r.status === 404, r.data?.error)

  // ── deleting the category takes its budgets with it ──
  // Regression: a budget used to block the delete with a raw foreign key
  // error surfacing as a 500.
  r = await call('POST', '/api/categories', {
    name: 'Temp Probe',
    type: 'Expense',
    color: '#888888'
  })
  check('crear categoria → 201', r.status === 201, JSON.stringify(r.data?.error || r.data.name))
  const probeCategory = r.data.id

  r = await call('POST', '/api/budgets', { categoryId: probeCategory, amount: 25, period: 'MONTH' })
  check('presupuesto sobre la categoria nueva → 201', r.status === 201, r.data?.error)

  r = await call('GET', '/api/categories')
  check(
    'budgetCount sube al crear el presupuesto',
    r.data.find(c => c.id === probeCategory).budgetCount === 1,
    JSON.stringify(r.data.find(c => c.id === probeCategory))
  )

  r = await call('DELETE', `/api/categories/${probeCategory}`)
  check('borrar categoria con presupuesto → 200, no 500', r.status === 200, JSON.stringify(r.data))

  r = await call('GET', '/api/budgets')
  check(
    'el presupuesto desaparece con la categoria',
    !r.data.budgets.some(b => b.categoryId === probeCategory),
    JSON.stringify(r.data.budgets)
  )

  // ── weekStart: la ventana semanal se ancla al día elegido ──
  // A category of its own, so no other spending can leak into the windows.
  r = await call('POST', '/api/categories', {
    name: 'Week Probe',
    type: 'Expense',
    color: '#123456'
  })
  check('categoria para la sonda semanal → 201', r.status === 201, JSON.stringify(r.data))
  const weekProbe = r.data.id
  await call('POST', '/api/budgets', { categoryId: weekProbe, amount: 10, period: 'WEEK' })

  // The most recent Sunday, and a Tuesday of that same week: with Monday as
  // the first day the Sunday belongs to the previous week, with Sunday as the
  // first day it opens the window.
  const sunday = new Date(today)
  sunday.setDate(sunday.getDate() - ((sunday.getDay() + 7) % 7))
  const sundayStr = dayString(sunday)
  const tuesdayStr = dayString(
    new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 2)
  )

  await call('POST', '/api/transactions', {
    amount: 4,
    type: 'Expense',
    description: 'sonda domingo',
    categoryId: weekProbe,
    date: sundayStr
  })

  r = await call('GET', `/api/budgets?period=WEEK&today=${tuesdayStr}&weekStart=SUNDAY`)
  const sunWeek = r.data.budgets.find(b => b.categoryId === weekProbe)
  check(
    'weekStart=SUNDAY: el domingo abre la ventana',
    sunWeek?.spent === 4,
    `spent=${sunWeek?.spent}`
  )

  r = await call('GET', `/api/budgets?period=WEEK&today=${tuesdayStr}&weekStart=MONDAY`)
  const monWeek = r.data.budgets.find(b => b.categoryId === weekProbe)
  check(
    'weekStart=MONDAY: el mismo domingo queda fuera',
    monWeek?.spent === 0,
    `spent=${monWeek?.spent}`
  )

  r = await call('GET', `/api/budgets?period=WEEK&today=${tuesdayStr}`)
  const defaultWeek = r.data.budgets.find(b => b.categoryId === weekProbe)
  check('sin weekStart se asume MONDAY', defaultWeek?.spent === 0, `spent=${defaultWeek?.spent}`)

  r = await call('GET', '/api/budgets?period=WEEK&weekStart=FUNDAY')
  check('weekStart invalido → 400', r.status === 400, r.data?.error)
})
