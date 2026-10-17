// Recurring rules: materialization (catch-up), no backfill, month-end
// clamping, intervals, pause/resume, edits, deletes, validation and isolation.
//
// The schedule is anchored to the real clock — "today" is whatever UTC day the
// suite runs on — so every expectation is derived from the current date
// instead of a hardcoded calendar. Aging a rule's nextDate (which is how the
// suite simulates days passing while the server was asleep) happens through
// db-cli.mjs, a short-lived child process: see the note in that file.
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withServer, createTestUser } from './helpers.mjs'

const DAY_MS = 86400000
const HERE = dirname(fileURLToPath(import.meta.url))
const DB_CLI = resolve(HERE, 'db-cli.mjs')

const pad2 = n => (n < 10 ? `0${n}` : String(n))
const toISO = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`

function utcDay(offsetDays = 0) {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * DAY_MS
  )
}

// Independent month walk: occurrence i keeps the start day, clamped to the
// target month's length. Written separately from the implementation so the
// expectations below are not just a copy of its arithmetic.
function monthlyOccurrences(start, count) {
  const anchorDay = start.getUTCDate()
  const out = []
  for (let i = 0; i < count; i++) {
    const total = start.getUTCMonth() + i
    const year = start.getUTCFullYear() + Math.floor(total / 12)
    const month = ((total % 12) + 12) % 12
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    out.push(new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay))))
  }
  return out
}

await withServer('recurring', async ctx => {
  const { call, check, state, dbFile } = ctx

  const databaseUrl = `file:${dbFile.replace(/\\/g, '/')}`
  const cli = (...args) => {
    const res = spawnSync('node', [DB_CLI, ...args], { encoding: 'utf8' })
    if (res.status !== 0) throw new Error(`db-cli ${args[0]} failed: ${res.stderr}`)
    return res.stdout
  }
  const ageRule = (id, date) => cli('age', databaseUrl, String(id), toISO(date))
  const countTx = id => Number(cli('count-tx', databaseUrl, String(id)).trim())

  const { expense, income } = await createTestUser(ctx)
  const today = utcDay(0)
  const todayISO = toISO(today)

  const createRule = overrides =>
    call('POST', '/api/recurring', {
      type: 'EXPENSE',
      amount: 10,
      description: 'Rule',
      categoryId: expense.id,
      frequency: 'MONTH',
      interval: 1,
      startDate: todayISO,
      ...overrides
    })

  // perPage=100: the default page holds 20 and the clamp test generates more
  // movements for one rule than that.
  const txList = async () => (await call('GET', '/api/transactions?perPage=100')).data.items
  const txOf = async ruleId => (await txList()).filter(t => t.recurringId === ruleId)

  // What a card action (pause/resume) sends: the rule as the API returned it,
  // reduced to the editable fields. Editing sends the same shape.
  const ruleBody = rule => ({
    type: rule.type,
    amount: rule.amount,
    description: rule.description,
    categoryId: rule.categoryId,
    frequency: rule.frequency,
    interval: rule.interval,
    startDate: String(rule.startDate).slice(0, 10),
    endDate: rule.endDate ? String(rule.endDate).slice(0, 10) : null
  })

  // ── Creation materializes today's occurrence ────────────────────────────
  let r = await createRule({ description: 'Rent', amount: 1200.5 })
  check('create → 201', r.status === 201, JSON.stringify(r.data))
  const rent = r.data
  check(
    'create: se genera la ocurrencia de hoy y nextDate salta un mes',
    toISO(new Date(rent.nextDate)) === toISO(monthlyOccurrences(today, 2)[1]),
    `next=${rent.nextDate}`
  )

  let txs = await txOf(rent.id)
  check(
    'create: el movimiento de hoy existe, con importe, tipo y categoría',
    txs.length === 1 &&
      toISO(new Date(txs[0].date)) === todayISO &&
      txs[0].amount === 1200.5 &&
      txs[0].type === 'EXPENSE' &&
      txs[0].categoryId === expense.id,
    JSON.stringify(txs[0] ?? null)
  )

  r = await createRule({
    type: 'INCOME',
    amount: 50,
    description: 'Pay',
    categoryId: income.id,
    frequency: 'WEEK'
  })
  txs = await txOf(r.data.id)
  check(
    'regla de ingreso semanal: generada hoy y nextDate = +7 días',
    r.status === 201 &&
      txs.length === 1 &&
      txs[0].type === 'INCOME' &&
      toISO(new Date(r.data.nextDate)) === toISO(utcDay(7)),
    `next=${r.data.nextDate}`
  )

  r = await createRule({ description: 'Daily', frequency: 'DAY' })
  txs = await txOf(r.data.id)
  check(
    'regla diaria: generada hoy y nextDate = +1 día',
    r.status === 201 && txs.length === 1 && toISO(new Date(r.data.nextDate)) === toISO(utcDay(1)),
    `next=${r.data.nextDate}`
  )

  r = await createRule({ description: 'Every 2 days', frequency: 'DAY', interval: 2 })
  check(
    'intervalo 2 días: nextDate = hoy + 2 días',
    r.status === 201 && toISO(new Date(r.data.nextDate)) === toISO(utcDay(2)),
    `next=${r.data.nextDate}`
  )

  r = await createRule({ description: 'Bi-monthly', interval: 2 })
  check(
    'intervalo 2: nextDate = hoy + 2 meses',
    r.status === 201 && toISO(new Date(r.data.nextDate)) === toISO(monthlyOccurrences(today, 3)[2]),
    `next=${r.data.nextDate}`
  )

  r = await createRule({ description: 'Max interval', frequency: 'WEEK', interval: 24 })
  check(
    'intervalo máximo (24): aceptado y nextDate = hoy + 24 semanas',
    r.status === 201 && toISO(new Date(r.data.nextDate)) === toISO(utcDay(168)),
    `next=${r.data.nextDate}`
  )

  // ── No backfill ─────────────────────────────────────────────────────────
  const past = utcDay(-40)
  r = await createRule({ description: 'No backfill', startDate: toISO(past) })
  const expectedNext = monthlyOccurrences(past, 4).find(d => d >= today)
  check(
    'sin backfill: nextDate es la próxima ocurrencia futura',
    r.status === 201 && toISO(new Date(r.data.nextDate)) === toISO(expectedNext),
    `next=${r.data.nextDate} expected=${toISO(expectedNext)}`
  )
  check('sin backfill: no se generó nada del pasado', (await txOf(r.data.id)).length === 0)

  // ── Catch-up of missed occurrences ──────────────────────────────────────
  r = await createRule({ description: 'Weekly', frequency: 'WEEK' })
  const weeklyId = r.data.id
  ageRule(weeklyId, utcDay(-21))
  await txList() // any authenticated request triggers the catch-up
  const missedDays = (await txOf(weeklyId)).map(t => toISO(new Date(t.date))).sort()
  check(
    'catch-up: materializa las tres semanas vencidas y no duplica hoy',
    missedDays.join() === [utcDay(-21), utcDay(-14), utcDay(-7), today].map(toISO).join(),
    missedDays.join()
  )
  const stable = missedDays.length
  await txList()
  await txList()
  check('catch-up repetido no duplica (índice único)', (await txOf(weeklyId)).length === stable)

  r = await createRule({ description: 'Daily catch-up', frequency: 'DAY' })
  const dailyId = r.data.id
  ageRule(dailyId, utcDay(-3))
  await txList()
  const dailyDays = (await txOf(dailyId)).map(t => toISO(new Date(t.date))).sort()
  check(
    'catch-up diario: una ocurrencia por día vencido',
    dailyDays.join() === [utcDay(-3), utcDay(-2), utcDay(-1), today].map(toISO).join(),
    dailyDays.join()
  )

  // ── Month-end clamp ─────────────────────────────────────────────────────
  const clampYear = today.getUTCFullYear() - 1
  const clampStart = new Date(Date.UTC(clampYear, 0, 31))
  r = await createRule({ description: 'Clamp', startDate: toISO(clampStart) })
  check('regla anclada al 31 de enero → 201', r.status === 201)
  const clampId = r.data.id
  ageRule(clampId, clampStart)
  await txList()
  const clampDays = (await txOf(clampId)).map(t => toISO(new Date(t.date))).sort()
  const expectedSeq = monthlyOccurrences(clampStart, 24)
    .filter(d => d <= today)
    .map(toISO)
  check(
    'catch-up completo: una ocurrencia por mes, mes a mes',
    clampDays.join() === expectedSeq.join(),
    `${clampDays.join()} vs ${expectedSeq.join()}`
  )
  const lastFeb = new Date(Date.UTC(clampYear, 2, 0)) // last day of February
  check(
    'clamp: 31 ene → último día de febrero, y vuelve al 31 en marzo',
    clampDays[1] === toISO(lastFeb) && clampDays[2] === `${clampYear}-03-31`,
    clampDays.slice(0, 3).join()
  )

  // ── endDate ─────────────────────────────────────────────────────────────
  r = await createRule({ description: 'Loan', endDate: todayISO })
  check(
    'endDate alcanzado: genera hoy y la regla queda inactiva',
    r.status === 201 && r.data.active === false && (await txOf(r.data.id)).length === 1,
    `active=${r.data.active}`
  )

  // ── Pause / resume ──────────────────────────────────────────────────────
  r = await createRule({ description: 'Pause', frequency: 'WEEK' })
  const pauseId = r.data.id
  r = await call('PUT', `/api/recurring/${pauseId}`, { ...ruleBody(r.data), active: false })
  check('pausar → 200 e inactiva', r.status === 200 && r.data.active === false)
  ageRule(pauseId, utcDay(-14)) // due dates pile up while paused
  await txList()
  check('pausada no materializa aunque esté vencida', (await txOf(pauseId)).length === 1)
  r = await call('PUT', `/api/recurring/${pauseId}`, { ...ruleBody(r.data), active: true })
  check(
    'reanudar → activa, sin rellenar lo pausado y con la próxima ocurrencia futura',
    r.status === 200 &&
      r.data.active === true &&
      (await txOf(pauseId)).length === 1 &&
      new Date(r.data.nextDate) > today,
    `next=${r.data.nextDate}`
  )

  // ── Edits affect only the future ────────────────────────────────────────
  r = await createRule({ description: 'Editable', frequency: 'WEEK' })
  const editId = r.data.id
  r = await call('PUT', `/api/recurring/${editId}`, { ...ruleBody(r.data), amount: 99 })
  check('editar importe → 200 con el valor nuevo', r.status === 200 && r.data.amount === 99)
  check(
    'editar: lo ya generado conserva el importe anterior',
    (await txOf(editId))[0]?.amount === 10
  )
  ageRule(editId, utcDay(-1))
  await txList()
  const later = await txOf(editId)
  check(
    'editar: la siguiente ocurrencia usa el importe nuevo',
    later.some(t => t.amount === 99 && toISO(new Date(t.date)) === toISO(utcDay(-1))),
    later.map(t => t.amount).join()
  )

  // ── Deleting ────────────────────────────────────────────────────────────
  r = await createRule({ description: 'Keep history' })
  const delId = r.data.id
  r = await call('DELETE', `/api/recurring/${delId}`)
  check('borrar regla → success', r.status === 200 && r.data.success === true)
  const survivors = (await txList()).filter(t => t.description === 'Keep history')
  check(
    'borrar regla: los movimientos quedan, sin recurringId',
    survivors.length === 1 && survivors[0].recurringId === null,
    JSON.stringify(survivors)
  )
  check(
    'borrar regla: ya no aparece en la lista',
    !(await call('GET', '/api/recurring')).data.some(x => x.id === delId)
  )
  check('borrar dos veces → 404', (await call('DELETE', `/api/recurring/${delId}`)).status === 404)

  r = await createRule({ description: 'One-shot delete', frequency: 'WEEK' })
  const onceId = r.data.id
  const [only] = await txOf(onceId)
  await call('DELETE', `/api/transactions/${only.id}`)
  await txList()
  await txList()
  check('borrar una ocurrencia no la resucita', (await txOf(onceId)).length === 0)

  // ── Replay of a queued create (clientId) ────────────────────────────────
  r = await createRule({ description: 'Replay', clientId: 'replay-1' })
  check('create con clientId → 201', r.status === 201)
  const replay = await createRule({ description: 'Replay', clientId: 'replay-1' })
  check(
    'replay del outbox → 200 con la misma regla',
    replay.status === 200 && replay.data.id === r.data.id,
    `status=${replay.status}`
  )
  check(
    'replay: una sola regla',
    (await call('GET', '/api/recurring')).data.filter(x => x.clientId === 'replay-1').length === 1
  )

  // ── Isolation between accounts ──────────────────────────────────────────
  const mine = state.token
  ageRule(weeklyId, utcDay(-30)) // the owner's rule is now overdue
  const countBefore = countTx(weeklyId)
  const other = await call('POST', '/auth/register', {
    name: 'Other',
    email: 'other@example.com',
    password: 'secret1'
  })
  state.token = other.data.token
  check('otra cuenta: sin reglas propias', (await call('GET', '/api/recurring')).data.length === 0)
  await txList()
  check('otra cuenta: no materializa las reglas ajenas', countTx(weeklyId) === countBefore)

  // A rule owned by the second account, then probed as the first.
  const otherExpense = (await call('GET', '/api/categories')).data.find(c => c.type === 'EXPENSE')
  const otherRule = await createRule({
    description: 'Owned by other',
    categoryId: otherExpense.id
  })
  check('otra cuenta: su propia regla se crea → 201', otherRule.status === 201)

  state.token = mine
  await txList()
  check('el dueño sí materializa lo vencido al pedir sus datos', countTx(weeklyId) > countBefore)
  check(
    'regla de otra cuenta: PUT → 404',
    (await call('PUT', `/api/recurring/${otherRule.data.id}`, {})).status === 404
  )
  check(
    'regla de otra cuenta: DELETE → 404',
    (await call('DELETE', `/api/recurring/${otherRule.data.id}`)).status === 404
  )

  // ── Validation ──────────────────────────────────────────────────────────
  const bad = [
    ['frecuencia desconocida', { frequency: 'DAILY' }],
    ['intervalo 0', { interval: 0 }],
    ['intervalo 25', { interval: 25 }],
    ['fin antes del inicio', { endDate: toISO(utcDay(-1)) }],
    ['categoría de otro tipo', { type: 'INCOME' }],
    ['sin descripción', { description: '   ' }],
    ['importe 0', { amount: 0 }],
    ['categoría inexistente', { categoryId: 999999 }]
  ]
  for (const [label, overrides] of bad) {
    const res = await createRule(overrides)
    check(`validación: ${label} → 400`, res.status === 400, `status=${res.status}`)
  }
  check(
    'validación: id inválido en PUT → 400',
    (await call('PUT', '/api/recurring/abc', {})).status === 400
  )
})
