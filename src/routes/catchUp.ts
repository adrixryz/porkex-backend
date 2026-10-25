import type { AuthRequest } from '../middleware/auth'
import { runDueRules, invalidateRecurring } from '../lib/recurring'
// Materialize due recurring rules before the request runs, so any response
// already reflects today's movements — including the first request after the
// free-tier server woke up. Empty schedules only perform indexed reads.
export async function catchUp(req: AuthRequest, res: import('express').Response, refresh = false) {
  try {
    if (refresh) invalidateRecurring(req.userId!)
    const result = await runDueRules(req.userId!, new Date(), res.locals.timeZone)
    res.setHeader('X-Porkex-Recurring-State', result.state)
  } catch (error) {
    res.setHeader('X-Porkex-Recurring-State', 'failed')
    console.error('Recurring catch-up failed.', error)
  }
}
