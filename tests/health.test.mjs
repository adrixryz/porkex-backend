import { withServer } from './helpers.mjs'

// The probe the hosting platform and uptime monitors hit: public, cheap, and
// honest about the database (a 200 that ignored a dead DB would be a lie).
await withServer('health', async ({ call, check }) => {
  const r = await call('GET', '/health')
  check('GET /health sin token → 200', r.status === 200, `status=${r.status}`)
  check('status ok', r.data?.status === 'ok', JSON.stringify(r.data))
  check('la base de datos responde', r.data?.db === 'up', JSON.stringify(r.data))
  check('responde JSON', String(r.contentType).includes('application/json'), r.contentType)
})
