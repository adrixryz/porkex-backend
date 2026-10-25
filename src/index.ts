import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import type { NextFunction, Request, Response } from 'express'
import apiRoutes from './routes/api'
import authRoutes from './routes/auth'
import { assertJwtSecretIsConfigured } from './middleware/auth'
import { apiLimiter, authLimiter } from './middleware/rateLimit'
import { prisma, databaseClient } from './lib/prisma'
import { checkDatabaseSchema } from '../scripts/lib/migrations'

const app = express()
const port = process.env.PORT || 3000

// dotenv has run by now, so the secret can be validated before the port opens.
assertJwtSecretIsConfigured()

// The app runs behind a single reverse proxy (Render). Trusting one hop is what
// makes req.ip the real client address, which the rate limiters key on.
app.set('trust proxy', 1)

/**
 * Which frontends may call this API, as a comma separated list of origins:
 *   CORS_ORIGINS="https://porkex-web.onrender.com,https://myapp.com"
 *
 * Left unset, no CORS headers are sent at all. That is the right default for
 * local development, where the Vite dev server proxies /api and /auth here, so
 * the browser only ever talks to one origin and CORS never comes into play.
 * When the two are deployed as separate services, set this to the frontend's
 * origin — without it the browser blocks the responses, which is a visible
 * error rather than a silent one.
 */
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)

if (CORS_ORIGINS.length > 0) {
  app.use(
    cors({
      origin: CORS_ORIGINS,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      // The access token travels in the Authorization header, which makes
      // every call a preflighted request. Without this the preflight fails and
      // the browser never sends the real one.
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Porkex-Time-Zone'],
      exposedHeaders: ['X-Porkex-Recurring-State'],
      maxAge: 86400
    })
  )
} else {
  console.log('CORS_ORIGINS is not set: no cross-origin access allowed (fine for development).')
}

app.use((req, res, next) => {
  if (/^\/api\/transactions\/import(?:\/preview)?\/?$/.test(req.path) && req.method === 'POST')
    return next()
  express.json()(req, res, next)
})

// Liveness probe for the hosting platform and uptime monitors. "The port
// answers" alone would miss the failure that actually happens — the database
// going away — so this pings it. Deliberately mounted before the rate
// limiters: probes are periodic and must never consume the API budget.
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ok', db: 'up' })
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down' })
  }
})

// Public routes (no auth required). The stricter limiter sits on /auth only:
// a brute-force attack targets those two endpoints, and every other request
// already needs a valid token.
app.use('/auth', authLimiter, authRoutes)

// Protected routes (auth required - middleware is applied inside api.ts)
app.use('/api', apiLimiter, apiRoutes)

// 404 for unknown routes (avoids empty HTML responses from the API)
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found.' })
})

// Last resort handler. Without this, express.json() parse failures end up in the
// default handler and the client receives an HTML body instead of JSON.
// Express detects an error handler by its arity, so _next must stay declared.
app.use(
  (
    err: Error & { status?: number; statusCode?: number; type?: string },
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    // express.json() reports a malformed body as a 400 with entity.parse.failed;
    // passing that status through keeps the client's error path meaningful
    // instead of turning a bad request into a server error.
    const status =
      typeof err.status === 'number'
        ? err.status
        : typeof err.statusCode === 'number'
          ? err.statusCode
          : 500

    if (status >= 500) {
      console.error('Unhandled error:', err)
      return res.status(status).json({ error: 'Internal server error.' })
    }

    const message =
      err.type === 'entity.parse.failed'
        ? 'Invalid JSON in request body.'
        : err.message || 'Request failed.'
    res.status(status).json({ error: message })
  }
)

async function start() {
  await checkDatabaseSchema(databaseClient)
  app.listen(port, () => {
    console.log(`🐷 Porkex API running at http://localhost:${port}`)
  })
}

void start().catch(async error => {
  console.error(
    'Startup refused:',
    error instanceof Error ? error.message : 'Invalid database schema.'
  )
  await prisma.$disconnect()
  databaseClient.close()
  process.exitCode = 1
})
