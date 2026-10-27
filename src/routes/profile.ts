import { acceptFinancialEdit } from '../lib/financialEdits'
import bcrypt from 'bcryptjs'
import { AuthRequest, generateToken } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { isValidCurrency } from '../lib/currencies'
import { passwordError } from '../lib/passwords'
import { FinanceError } from '../lib/finance'
import { Router } from 'express'
import {
  MAX_PROFILE_NAME_LENGTH,
  DECIMAL_SEPARATORS,
  isDefaultPeriod,
  isWeekDay,
  cleanText,
  PROFILE_SELECT
} from './apiShared'

export const profileRouter = Router()

profileRouter.get('/profile', async (req: AuthRequest, res) => {
  const userId = req.userId!
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: PROFILE_SELECT
    })
    if (!user) return res.status(404).json({ error: 'User not found.' })
    res.json(user)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to fetch profile.', error)
    res.status(500).json({ error: 'Failed to fetch profile.' })
  }
})

profileRouter.put('/profile', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const data: {
    name?: string
    currency?: string
    defaultPeriod?: string
    firstDayOfWeek?: string
    decimalSeparator?: string
    language?: string
  } = {}

  // Every field is optional, so the client can update one without sending the others.
  if (req.body?.name !== undefined) {
    const name = cleanText(req.body.name)
    if (!name) {
      return res.status(400).json({ error: 'Name is required.' })
    }
    if (name.length > MAX_PROFILE_NAME_LENGTH) {
      return res
        .status(400)
        .json({ error: `Name must be at most ${MAX_PROFILE_NAME_LENGTH} characters.` })
    }
    data.name = name
  }

  if (req.body?.currency !== undefined) {
    if (!isValidCurrency(req.body.currency)) {
      return res.status(400).json({ error: 'Unsupported currency code.' })
    }
    data.currency = req.body.currency
  }

  if (req.body?.defaultPeriod !== undefined) {
    if (!isDefaultPeriod(req.body.defaultPeriod)) {
      return res.status(400).json({ error: 'Default period must be day, week, month or year.' })
    }
    data.defaultPeriod = req.body.defaultPeriod
  }

  if (req.body?.firstDayOfWeek !== undefined) {
    if (!isWeekDay(req.body.firstDayOfWeek)) {
      return res.status(400).json({ error: 'First day of the week must be a day name.' })
    }
    data.firstDayOfWeek = req.body.firstDayOfWeek
  }

  if (req.body?.decimalSeparator !== undefined) {
    if (!DECIMAL_SEPARATORS.includes(req.body.decimalSeparator)) {
      return res.status(400).json({ error: 'Decimal separator must be "." or ",".' })
    }
    data.decimalSeparator = req.body.decimalSeparator
  }

  if (req.body?.language !== undefined) {
    if (req.body.language !== 'en' && req.body.language !== 'es')
      return res.status(400).json({ error: 'Language must be en or es.' })
    data.language = req.body.language
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' })
  }

  try {
    const user = await prisma.$transaction(async db => {
      for (const field of Object.keys(data))
        await acceptFinancialEdit(db, userId, `profile:${field}`, req.body ?? {})
      return db.user.update({ where: { id: userId }, data, select: PROFILE_SELECT })
    })
    res.json(user)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Profile update failed.', error)
    res.status(500).json({ error: 'Profile update failed.' })
  }
})

profileRouter.post('/sessions/revoke', async (req: AuthRequest, res) => {
  try {
    const version = req.sessionVersion!
    const updated = await prisma.user.updateMany({
      where: { id: req.userId!, sessionVersion: version },
      data: { sessionVersion: { increment: 1 } }
    })
    if (!updated.count)
      return res.status(401).json({ error: 'This session was revoked. Sign in again.' })
    res.json({ success: true, token: generateToken(req.userId!, version + 1) })
  } catch {
    res
      .status(503)
      .json({ error: 'Could not confirm session revocation. Sign in again if necessary.' })
  }
})

profileRouter.put('/password', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const currentPassword = req.body?.currentPassword
  const newPassword = req.body?.newPassword

  if (
    typeof currentPassword !== 'string' ||
    !currentPassword ||
    typeof newPassword !== 'string' ||
    !newPassword
  ) {
    return res.status(400).json({ error: 'Current and new password are required.' })
  }

  // Same policy as registration (see lib/passwords.ts).
  const pwError = passwordError(newPassword, 'New password')
  if (pwError) return res.status(400).json({ error: pwError })

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return res.status(404).json({ error: 'User not found.' })

    const valid = await bcrypt.compare(currentPassword, user.password)
    // 400, never 401: the frontend treats a 401 as an expired session and
    // would log the user out over a simple typo.
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect.' })

    const hashed = await bcrypt.hash(newPassword, 10)
    const updated = await prisma.user.updateMany({
      where: { id: userId, sessionVersion: req.sessionVersion!, password: user.password },
      data: { password: hashed, sessionVersion: { increment: 1 } }
    })
    if (!updated.count)
      return res.status(401).json({ error: 'This session was revoked. Sign in again.' })
    res.json({ success: true, token: generateToken(userId, req.sessionVersion! + 1) })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Password change failed.', error)
    res.status(500).json({ error: 'Password change failed.' })
  }
})
