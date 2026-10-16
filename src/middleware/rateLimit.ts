import { rateLimit } from 'express-rate-limit'

// Generous limits on purpose: this is a personal app, so the goal is not to
// throttle its owner but to make brute-force guessing impractical on a public
// URL. Both limits can be overridden from the environment (the tests use that
// to exercise the 429 path quickly).

// Only failed attempts count (skipSuccessfulRequests), so normal logins never
// consume the budget. Default: 30 failures per 15 minutes per IP.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT_MAX) || 30,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' }
})

// A ceiling for the whole API: 600 requests per minute per IP, orders of
// magnitude above anything this app does in normal use.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT_MAX) || 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
})
