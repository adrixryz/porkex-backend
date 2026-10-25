import express, { Router } from 'express'
import type { AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { FinanceError } from '../lib/finance'
import { dayKey } from '../lib/dates'
import { fromCents } from '../lib/money'
import { tagInclude } from '../lib/tags'
import { transactionFilters } from '../lib/transactionFilters'
import {
  CSV_HEADER,
  csvCell,
  previewCsv,
  importCsv,
  CSV_TRANSACTION_TIMEOUT_MS
} from '../lib/movementCsv'
import { invalidateRecurring } from '../lib/recurring'

export const movementCsvRouter = Router()

movementCsvRouter.get('/transactions/import/:id', async (req: AuthRequest, res, next) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id)))
    return res.status(400).json({ error: 'Invalid import ID.' })
  try {
    const receipt = await prisma.financialReceipt.findUnique({
      where: { userId_key: { userId: req.userId!, key: `csv:import:${req.params.id}` } }
    })
    res.setHeader('Cache-Control', 'no-store')
    res.json(
      receipt
        ? { state: 'confirmed', result: JSON.parse(receipt.response) }
        : { state: 'unconfirmed' }
    )
  } catch (error) {
    next(error)
  }
})

movementCsvRouter.get('/transactions/export', async (req: AuthRequest, res, next) => {
  try {
    const where = await transactionFilters(req.userId!, req.query as Record<string, unknown>)
    const rows = await prisma.transaction.findMany({
      where,
      include: { account: true, category: true, ...tagInclude },
      orderBy: [{ date: 'asc' }, { id: 'asc' }]
    })
    const csv =
      [
        CSV_HEADER.join(';'),
        ...rows.map(row =>
          [
            dayKey(row.date),
            row.type,
            row.account?.isMain || !row.account ? 'Main' : row.account.name,
            row.category.name,
            row.tags
              .sort((a, b) => a.tag.position - b.tag.position || a.tag.id.localeCompare(b.tag.id))
              .map(link => link.tag.name)
              .join(','),
            row.description,
            fromCents(row.amount).toFixed(2)
          ]
            .map(csvCell)
            .join(';')
        )
      ].join('\r\n') + '\r\n'
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Disposition', 'attachment; filename="porkex-backup.csv"')
    res.type('text/csv').send('\uFEFF' + csv)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    next(error)
  }
})

// Only these routes accept a larger body; ordinary API requests keep their limit.
// Complete CSV backups have no application-imposed row or byte cap.
movementCsvRouter.use('/transactions/import', express.json({ limit: Infinity }))
movementCsvRouter.post('/transactions/import/preview', async (req: AuthRequest, res, next) => {
  try {
    const result = await prisma.$transaction(
      db => previewCsv(req.userId!, req.body?.csv, res.locals.today, db),
      { maxWait: 30000, timeout: CSV_TRANSACTION_TIMEOUT_MS }
    )
    res.setHeader('Cache-Control', 'no-store')
    res.json(result)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    next(error)
  }
})
movementCsvRouter.post('/transactions/import', async (req: AuthRequest, res, next) => {
  try {
    const result = await importCsv(req.userId!, req.body ?? {}, res.locals.today)
    invalidateRecurring(req.userId!)
    res.json(result)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    next(error)
  }
})
