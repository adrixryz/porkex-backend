import { Router } from 'express'
import type { Favorite } from '@prisma/client'
import type { AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { fromCents, toCents } from '../lib/money'
import { movementAccount, financialWrite, FinanceError } from '../lib/finance'
import { commentInput, resolveTagIds } from '../lib/tags'
export const favoritesRouter = Router()
const serialize = (row: Favorite) => ({
  ...row,
  amount: fromCents(row.amount),
  tagIds: JSON.parse(row.tagIds) as string[]
})
favoritesRouter.get('/', async (req: AuthRequest, res) => {
  try {
    res.json(
      (
        await prisma.favorite.findMany({
          where: { userId: req.userId! },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
        })
      ).map(serialize)
    )
  } catch {
    res.status(500).json({ error: 'Could not load favorites.' })
  }
})
for (const method of ['post', 'put', 'delete'] as const)
  favoritesRouter[method](method === 'post' ? '/' : '/:id', async (req: AuthRequest, res) => {
    try {
      const userId = req.userId!,
        body = req.body ?? {},
        id = method === 'post' ? body.id : String(req.params.id)
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
        throw new FinanceError('Invalid favorite ID.')
      const result = await financialWrite(
        userId,
        method === 'post' ? `favorite:create:${id}` : null,
        async db => {
          const old = await db.favorite.findFirst({ where: { id, userId } })
          if (method !== 'post' && !old) throw new FinanceError('Favorite not found.', 404)
          if (method === 'delete') {
            await db.favorite.delete({ where: { id } })
            return { success: true }
          }
          const amount = toCents(body.amount),
            comment = commentInput(body),
            categoryId = Number(body.categoryId),
            tagIds = await resolveTagIds(userId, body.tagIds ?? [], db)
          if (
            typeof body.name !== 'string' ||
            !body.name.trim() ||
            body.name.trim().length > 60 ||
            !['INCOME', 'EXPENSE'].includes(body.type) ||
            amount === null ||
            comment === null ||
            tagIds === null
          )
            throw new FinanceError(
              'Enter a name, positive amount, valid type, comment and up to five tags.'
            )
          const category = await db.category.findFirst({
            where: { id: categoryId, userId, type: body.type }
          })
          if (!category) throw new FinanceError('Choose a valid category.')
          const account = await movementAccount(userId, body.accountId, db)
          const data = {
            name: body.name.trim(),
            amount,
            type: body.type,
            comment,
            categoryId,
            accountId: account.id,
            tagIds: JSON.stringify(tagIds)
          }
          return serialize(
            method === 'post'
              ? await db.favorite.create({ data: { ...data, id, userId } })
              : await db.favorite.update({ where: { id }, data })
          )
        }
      )
      res.status(method === 'post' ? 201 : 200).json(result)
    } catch (error) {
      res
        .status(error instanceof FinanceError ? error.status : 500)
        .json({ error: error instanceof FinanceError ? error.message : 'Could not save favorite.' })
    }
  })
