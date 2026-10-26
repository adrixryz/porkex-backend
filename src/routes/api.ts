import { catchUp } from './catchUp'
import { Router } from 'express'
import { AuthRequest, authMiddleware } from '../middleware/auth'
import { tagsRouter } from './tags'
import { movementCsvRouter } from './movementCsv'
import { comparisonsRouter } from './comparisons'
import { occurrencesRouter } from './occurrences'
import { invalidateRecurring } from '../lib/recurring'
import { isTimeZone, todayInZone } from '../lib/dates'
import { favoritesRouter } from './favorites'
import { accountsRouter } from './accounts'
import { dashboardRouter } from './dashboard'
import { analyticsRouter } from './analytics'
import { transactionsRouter } from './transactions'
import { categoriesRouter } from './categories'
import { budgetsRouter } from './budgets'
import { recurringRouter } from './recurring'
import { profileRouter } from './profile'
import { backupRouter } from './backup'
const router = Router()

// Apply auth middleware to ALL routes in this file
router.use(authMiddleware)

router.use(async (req: AuthRequest, res, next) => {
  const timeZone = req.get('X-Porkex-Time-Zone') ?? 'America/Lima'
  if (!isTimeZone(timeZone)) return res.status(400).json({ error: 'Invalid time zone.' })
  res.locals.timeZone = timeZone
  res.locals.today = todayInZone(timeZone)
  if (
    !['GET', 'HEAD'].includes(req.method) &&
    (req.path.startsWith('/recurring') || /^\/categories\/\d+$/.test(req.path))
  ) {
    invalidateRecurring(req.userId!)
    res.once('finish', () => invalidateRecurring(req.userId!))
  }
  await catchUp(req, res)
  next()
})

router.use(movementCsvRouter)
router.use(backupRouter)
router.use(accountsRouter)
router.use('/favorites', favoritesRouter)
router.use('/tags', tagsRouter)
router.use('/analytics', comparisonsRouter)
router.use('/recurring', occurrencesRouter)

router.use(dashboardRouter)
router.use(analyticsRouter)
router.use(transactionsRouter)
router.use(categoriesRouter)
router.use(budgetsRouter)
router.use(recurringRouter)
router.use(profileRouter)

export default router
