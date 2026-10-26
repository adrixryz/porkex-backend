import { acceptFinancialEdit } from '../lib/financialEdits'
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { fromCents } from '../lib/money'
import { isUniqueViolation } from '../lib/errors'
import { assertCategoryNameAvailable, nextCategoryPosition } from '../lib/categories'
import { FinanceError } from '../lib/finance'
import { Router } from 'express'
import { parseCategoryId, resolveRange, parseClientId, validateCategoryInput } from './apiShared'

export const categoriesRouter = Router()

categoriesRouter.get('/categories', async (req: AuthRequest, res) => {
  const userId = req.userId!
  try {
    const { range, error } = resolveRange(req.query as Record<string, unknown>)
    if (error) return res.status(400).json({ error })

    const catsPromise = prisma.category.findMany({
      where: { userId },
      orderBy: [{ position: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      // All-time counts: the UI needs the movement count to know whether
      // deleting requires a reassignment target (which ignores the selected
      // period), and the budget and rule counts to warn about what else goes.
      include: { _count: { select: { transactions: true, budgets: true, recurringRules: true } } }
    })

    const where: Prisma.TransactionWhereInput = { userId }
    if (range) where.date = range

    // Sum and number of movements per category within the same period. The
    // category list and the grouping are independent, so they run together.
    const [cats, sums] = await Promise.all([
      catsPromise,
      prisma.transaction.groupBy({
        by: ['categoryId'],
        where,
        _sum: { amount: true },
        _count: { _all: true }
      })
    ])

    const totalByCat = new Map(sums.map(s => [s.categoryId, fromCents(s._sum.amount || 0)]))
    const countByCat = new Map(sums.map(s => [s.categoryId, s._count._all]))

    res.json(
      cats.map(c => {
        // _count is an implementation detail of this query; the response only
        // carries the two derived totals.
        const { _count, ...rest } = c
        return {
          ...rest,
          transactionCount: countByCat.get(c.id) || 0,
          total: totalByCat.get(c.id) || 0,
          allTimeCount: _count.transactions,
          budgetCount: _count.budgets,
          recurringCount: _count.recurringRules
        }
      })
    )
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Failed to fetch categories', error)
    res.status(500).json({ error: 'Failed to fetch categories' })
  }
})

categoriesRouter.post('/categories', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const parsed = parseClientId(req.body?.clientId)
  if (!parsed.ok) return res.status(400).json({ error: 'Invalid clientId.' })
  const clientId = parsed.value
  const findExisting = () => prisma.category.findFirst({ where: { userId, clientId } })

  try {
    if (clientId) {
      const existing = await findExisting()
      if (existing) return res.status(200).json(existing)
    }
    const v = validateCategoryInput(req.body ?? {})
    if (v.error) return res.status(400).json({ error: v.error })
    const result = await prisma.$transaction(async db => {
      if (clientId) {
        const saved = await db.category.findFirst({ where: { userId, clientId } })
        if (saved) return { cat: saved, created: false }
      }
      await assertCategoryNameAvailable(userId, v.name!, db)
      const cat = await db.category.create({
        data: {
          name: v.name!,
          type: v.type!,
          color: v.color ?? null,
          userId,
          clientId,
          position: await nextCategoryPosition(userId, db)
        }
      })
      return { cat, created: true }
    })
    res.status(result.created ? 201 : 200).json(result.cat)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    // Preserve conflicts and idempotent responses for database uniqueness failures.
    if (isUniqueViolation(error)) {
      if (clientId) {
        const existing = await findExisting()
        if (existing) return res.status(200).json(existing)
      }
      return res.status(409).json({ error: 'A category with that name already exists.' })
    }
    console.error('Category creation failed.', error)
    res.status(500).json({ error: 'Category creation failed.' })
  }
})

categoriesRouter.put('/categories/order', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const ids: unknown = req.body?.ids
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.some(id => !Number.isInteger(id) || id <= 0 || id > 2147483647) ||
    new Set(ids).size !== ids.length
  )
    return res.status(400).json({ error: 'Provide unique category IDs in the requested order.' })
  try {
    await prisma.$transaction(async db => {
      await acceptFinancialEdit(db, userId, 'categories:order', req.body ?? {})
      const categories = await db.category.findMany({
        where: { userId },
        orderBy: [{ position: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      })
      const owned = new Set(categories.map(category => category.id))
      if (ids.some(id => !owned.has(id)))
        throw new FinanceError(
          'A category is no longer available. Refresh the list before reordering.',
          409
        )
      const selected = new Set(ids)
      let index = 0
      const ordered = categories.map(category =>
        selected.has(category.id) ? (ids[index++] as number) : category.id
      )
      for (const [position, id] of ordered.entries())
        await db.category.update({ where: { id }, data: { position } })
    })
    res.json({ success: true })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Category ordering failed.', error)
    res.status(500).json({ error: 'Could not save category order.' })
  }
})

categoriesRouter.put('/categories/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const catId = Number(req.params.id)
  if (!Number.isInteger(catId) || catId <= 0) {
    return res.status(400).json({ error: 'Invalid category id.' })
  }
  const v = validateCategoryInput(req.body ?? {})
  if (v.error) return res.status(400).json({ error: v.error })

  try {
    const cat = await prisma.$transaction(async db => {
      await acceptFinancialEdit(db, userId, `category:${catId}`, req.body ?? {})
      const existing = await db.category.findFirst({ where: { id: catId, userId } })
      if (!existing) throw new FinanceError('Category not found.', 404)

      await assertCategoryNameAvailable(userId, v.name!, db, catId)

      // Do not allow changing the type when transactions already reference it.
      if (existing.type !== v.type) {
        if (await db.budget.count({ where: { userId, categoryId: catId } }))
          throw new FinanceError('Remove spending budgets before changing this category type.', 409)
        if (await db.favorite.count({ where: { userId, categoryId: catId } }))
          throw new FinanceError(
            'Update or remove linked favorites before changing this category type.',
            409
          )
        const txCount = await db.transaction.count({ where: { categoryId: catId, userId } })
        if (txCount > 0) {
          throw new FinanceError('Cannot change type: category has existing transactions.', 409)
        }
        const incompatibleOverrides = await db.occurrenceOverride.count({
          where: { categoryId: catId, processedAt: null }
        })
        if (incompatibleOverrides)
          throw new FinanceError(
            'Category is used by a next-only edit. Edit or skip that occurrence first.',
            409
          )
        const incompatibleRules = await db.recurringRule.count({
          where: { categoryId: catId, userId, type: { not: v.type! } }
        })
        if (incompatibleRules > 0) {
          throw new FinanceError(
            'Cannot change type: category has incompatible recurring rules.',
            409
          )
        }
      }

      return db.category.update({
        where: { id: catId },
        // A missing color keeps the stored one; a sent color replaces it.
        data: { name: v.name!, type: v.type!, color: v.color === null ? existing.color : v.color }
      })
    })
    res.json(cat)
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: 'A category with that name already exists.' })
    }
    console.error('Category update failed.', error)
    res.status(500).json({ error: 'Category update failed.' })
  }
})

categoriesRouter.delete('/categories/:id', async (req: AuthRequest, res) => {
  const userId = req.userId!
  const catId = Number(req.params.id)
  if (!Number.isInteger(catId) || catId <= 0) {
    return res.status(400).json({ error: 'Invalid category id.' })
  }
  try {
    const existing = await prisma.category.findFirst({ where: { id: catId, userId } })
    if (!existing) return res.status(404).json({ error: 'Category not found.' })

    if (await prisma.occurrenceOverride.count({ where: { categoryId: catId, processedAt: null } }))
      return res.status(409).json({
        error: 'Category is used by a next-only edit. Edit or skip that occurrence first.'
      })
    const txCount = await prisma.transaction.count({ where: { categoryId: catId, userId } })
    if (txCount === 0) {
      // Recurring rules go with their category. Deleted explicitly — not left
      // to the foreign key — because the additive deploy tool cannot add or
      // change constraints on the production tables.
      await prisma.$transaction([
        prisma.recurringRule.deleteMany({ where: { categoryId: catId, userId } }),
        prisma.favorite.deleteMany({ where: { userId, categoryId: catId } }),
        prisma.category.delete({ where: { id: catId } })
      ])
      return res.json({ success: true, moved: 0 })
    }

    // With movements a target category is required; without it the request is rejected.
    const rawTarget = req.query.reassignTo ?? req.body?.reassignTo
    if (rawTarget === undefined || rawTarget === null || rawTarget === '') {
      return res.status(409).json({
        error: 'Cannot delete category with existing transactions.',
        needsReassignment: true,
        transactionCount: txCount
      })
    }

    const targetId = parseCategoryId(rawTarget)
    if (targetId === null) {
      return res.status(400).json({ error: 'Invalid reassignment target category.' })
    }
    if (targetId === catId) {
      return res.status(400).json({ error: 'Cannot reassign transactions to the same category.' })
    }

    const target = await prisma.category.findFirst({ where: { id: targetId, userId } })
    if (!target) return res.status(404).json({ error: 'Target category not found.' })
    if (target.type !== existing.type) {
      return res.status(400).json({
        error: `Target category "${target.name}" is ${target.type}, but "${existing.name}" is ${existing.type}.`
      })
    }

    await prisma.$transaction([
      // Movements generated by this category's rules lose the pointer to
      // their template before it disappears (same reason as above).
      prisma.transaction.updateMany({
        where: { userId, recurring: { categoryId: catId } },
        data: { recurringId: null }
      }),
      prisma.recurringRule.deleteMany({ where: { categoryId: catId, userId } }),
      prisma.transaction.updateMany({
        where: { categoryId: catId, userId },
        data: { categoryId: targetId, editedAt: new Date(), lastEditId: randomUUID() }
      }),
      prisma.favorite.updateMany({
        where: { userId, categoryId: catId },
        data: { categoryId: targetId }
      }),
      prisma.category.delete({ where: { id: catId } })
    ])

    res.json({ success: true, moved: txCount, reassignedTo: target.name })
  } catch (error) {
    if (error instanceof FinanceError)
      return res.status(error.status).json({ error: error.message })
    console.error('Delete failed.', error)
    res.status(500).json({ error: 'Delete failed.' })
  }
})
