import { Router, json } from 'express'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma'
import {
  accountSnapshot,
  backupCounts,
  backupHash,
  replaceAccountData,
  validateFullBackup
} from '../lib/fullBackup'
import { FinanceError } from '../lib/finance'
import { AuthRequest, generateToken } from '../middleware/auth'
import { invalidateRecurring } from '../lib/recurring'

export const backupRouter = Router()
backupRouter.use('/backup', json({ limit: Infinity }), (_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})
const failure = (res: import('express').Response, error: unknown, restoring = false) => {
  if (error instanceof FinanceError) return res.status(error.status).json({ error: error.message })
  console.error('Full backup failed.', error)
  return res.status(500).json({
    error: restoring
      ? 'The restore could not be completed. No partial restore was applied.'
      : 'The backup could not be prepared. Your data was not changed.'
  })
}
backupRouter.get('/backup', async (req: AuthRequest, res) => {
  try {
    const backup = await prisma.$transaction(db => accountSnapshot(db, req.userId!), {
      timeout: 180_000
    })
    res
      .attachment(`porkex-all-data-${new Date().toISOString().slice(0, 10)}.json`)
      .json({ ...backup, exportedAt: new Date().toISOString() })
  } catch (error) {
    failure(res, error)
  }
})
backupRouter.get('/backup/restores/:id', async (req: AuthRequest, res) => {
  const receipt = await prisma.financialReceipt.findUnique({
    where: { userId_key: { userId: req.userId!, key: `backup:restore:${req.params.id}` } }
  })
  res.json(
    receipt ? { state: 'confirmed', ...JSON.parse(receipt.response) } : { state: 'unconfirmed' }
  )
})
backupRouter.post('/backup/preview', async (req: AuthRequest, res) => {
  try {
    const backup = validateFullBackup(req.body?.backup)
    const current = await prisma.$transaction(db => accountSnapshot(db, req.userId!), {
      timeout: 180_000
    })
    res.json({
      fingerprint: backupHash(backup),
      revision: backupHash(current),
      counts: backupCounts(backup),
      currentCounts: backupCounts(current)
    })
  } catch (error) {
    failure(res, error)
  }
})
backupRouter.post('/backup/restore', async (req: AuthRequest, res) => {
  try {
    const backup = validateFullBackup(req.body?.backup)
    const { importId, fingerprint, revision } = req.body ?? {}
    if (
      typeof importId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(importId) ||
      fingerprint !== backupHash(backup)
    )
      throw new FinanceError('The restore selection is invalid. Preview the file again.')
    const result = await prisma.$transaction(
      async db => {
        const key = `backup:restore:${importId}`
        const existing = await db.financialReceipt.findUnique({
          where: { userId_key: { userId: req.userId!, key } }
        })
        if (existing) {
          const receipt = JSON.parse(existing.response)
          if (receipt.fingerprint !== fingerprint)
            throw new FinanceError('This restore ID belongs to a different backup.', 409)
          const user = await db.user.findUniqueOrThrow({ where: { id: req.userId! } })
          return { ...receipt, token: generateToken(user.id, user.sessionVersion) }
        }
        if (backupHash(await accountSnapshot(db, req.userId!)) !== revision)
          throw new FinanceError(
            'Your data changed after the preview. Preview the file again before restoring.',
            409
          )
        const user = await replaceAccountData(db, req.userId!, backup)
        const receipt = {
          fingerprint,
          counts: backupCounts(backup),
          restoredAt: new Date().toISOString(),
          receiptId: randomUUID()
        }
        await db.financialReceipt.create({
          data: { userId: user.id, key, response: JSON.stringify(receipt) }
        })
        return { ...receipt, token: generateToken(user.id, user.sessionVersion) }
      },
      { timeout: 180_000 }
    )
    invalidateRecurring(req.userId!)
    res.json(result)
  } catch (error) {
    failure(res, error, true)
  }
})
