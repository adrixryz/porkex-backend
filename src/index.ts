import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';
import apiRoutes from './routes/api';
import authRoutes from './routes/auth';
import { assertJwtSecretIsConfigured } from './middleware/auth';

const app = express();
const port = process.env.PORT || 3000;

// dotenv has run by now, so the secret can be validated before the port opens.
assertJwtSecretIsConfigured();

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
  .map((origin) => origin.trim())
  .filter(Boolean);

if (CORS_ORIGINS.length > 0) {
  app.use(
    cors({
      origin: CORS_ORIGINS,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      // The access token travels in the Authorization header, which makes
      // every call a preflighted request. Without this the preflight fails and
      // the browser never sends the real one.
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86400
    })
  );
} else {
  console.log('CORS_ORIGINS is not set: no cross-origin access allowed (fine for development).');
}

app.use(express.json());

// Public routes (no auth required)
app.use('/auth', authRoutes);

// Protected routes (auth required - middleware is applied inside api.ts)
app.use('/api', apiRoutes);

// 404 for unknown routes (avoids empty HTML responses from the API)
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Last resort handler. Without this, express.json() parse failures end up in the
// default handler and the client receives an HTML body instead of JSON.
// Express detects an error handler by its arity, so _next must stay declared.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(port, () => {
  console.log(`🐷 Porkex API running at http://localhost:${port}`);
});