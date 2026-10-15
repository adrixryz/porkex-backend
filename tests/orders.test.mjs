
import { withServer } from './helpers.mjs'

await withServer('orders', async ({ call, check, results, state }) => {
  // The fixtures below are inserted with deliberate gaps so createdAt differs
  // measurably between them.
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  let r = await call('POST', '/auth/register', { name: 'T', email: 'o@o.com', password: 'secret1' })
  state.token = r.data.token
  const cats = (await call('GET', '/api/categories')).data
  const expense = cats.find(c => c.type === 'EXPENSE')

  // Se crean tres movimientos con fecha propia DELIBERADAMENTE invertida:
  // el Ãºltimo en insertarse es el de fecha mÃ¡s antigua.
  const old = new Date(2023, 0, 10, 12).toISOString()
  const mid = new Date(2024, 5, 10, 12).toISOString()
  const recent = new Date(2026, 9, 1, 12).toISOString()

  await call('POST', '/api/transactions', { amount: 10, type: 'EXPENSE', description: 'A - old date', categoryId: expense.id, date: old })
  await sleep(1100)
  await call('POST', '/api/transactions', { amount: 20, type: 'EXPENSE', description: 'B - mid date', categoryId: expense.id, date: mid })
  await sleep(1100)
  await call('POST', '/api/transactions', { amount: 30, type: 'EXPENSE', description: 'C - recent date', categoryId: expense.id, date: recent })

  r = await call('GET', '/api/transactions')
  const order = r.data.items.map(i => i.description)
  check('default ordena por createdAt desc (C, B, A)', order.join(' | ') === 'C - recent date | B - mid date | A - old date', order.join(' | '))

  check('createdAt viene en la respuesta', !!r.data.items[0].createdAt, r.data.items[0].createdAt)

  const cr = r.data.items.map(i => new Date(i.createdAt).getTime())
  check('createdAt estrictamente descendente', cr.every((v, i) => i === 0 || cr[i - 1] >= v), cr.join(','))

  r = await call('GET', '/api/dashboard')
  const dash = r.data.recentTransactions.map(i => i.description)
  check('dashboard: recientes por createdAt desc', dash.join(' | ') === 'C - recent date | B - mid date | A - old date', dash.join(' | '))

  r = await call('GET', '/api/transactions?sortBy=date&order=desc')
  check('sortBy=date sigue ordenando por la fecha propia', r.data.items[0].description === 'C - recent date', r.data.items.map(i => i.description).join(' | '))

  r = await call('GET', '/api/transactions?sortBy=date&order=asc')
  check('sortBy=date&order=asc', r.data.items[0].description === 'A - old date', r.data.items.map(i => i.description).join(' | '))

  r = await call('GET', '/api/transactions?sortBy=amount&order=desc')
  check('sortBy=amount&order=desc', r.data.items.map(i => i.amount).join(',') === '30,20,10', r.data.items.map(i => i.amount).join(','))

  r = await call('GET', '/api/transactions?sortBy=bogus')
  check('sortBy invÃ¡lido cae al default (createdAt desc)', r.data.items[0].description === 'C - recent date', r.data.items[0].description)

  r = await call('POST', '/api/transactions', { amount: 40, type: 'EXPENSE', description: 'D - sin fecha', categoryId: expense.id })
  r = await call('GET', '/api/transactions')
  check('nuevo insertado va primero', r.data.items[0].description === 'D - sin fecha', r.data.items[0].description)
  check('sin fecha => createdAt = now', Math.abs(Date.now() - new Date(r.data.items[0].createdAt).getTime()) < 60000, r.data.items[0].createdAt)

  r = await call('PUT', `/api/transactions/${r.data.items[0].id}`, {
    amount: 40, type: 'EXPENSE', description: 'D - editada', categoryId: expense.id, date: recent
  })
  check('PUT no altera createdAt', Math.abs(Date.now() - new Date(r.data.createdAt).getTime()) < 60000, r.data.createdAt)

  r = await call('GET', '/api/analytics?months=6&days=30')
  check('analytics sigue aggregating por fecha propia', r.status === 200 && r.data.monthlyData.length === 6)

  console.log('\n' + results.join('\n'))
})


