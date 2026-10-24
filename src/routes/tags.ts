import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma'
import type { AuthRequest } from '../middleware/auth'
import { tagName, validTagId } from '../lib/tags'
import { isUniqueViolation } from '../lib/errors'

export const tagsRouter = Router()
const include = { references: { select: { id: true } } } as const
const visible = <T extends { references: { id: string }[]; normalizedName: string }>(tag: T) => {
  const { references, normalizedName: _normalized, ...rest } = tag
  void _normalized
  return { ...rest, aliases: references.map(ref => ref.id) }
}
tagsRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    res.json(
      (
        await prisma.tag.findMany({
          where: { userId: req.userId! },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          include
        })
      ).map(visible)
    )
  } catch (error) {
    next(error)
  }
})
tagsRouter.post('/', async (req: AuthRequest, res, next) => {
  const name = tagName(req.body?.name)
  const id = req.body?.id
  if (!name || !validTagId(id))
    return res
      .status(400)
      .json({ error: 'A stable tag id and a name of 1–20 characters are required.' })
  const userId = req.userId!
  try {
    const tag = await prisma.$transaction(async db => {
      const ref = await db.tagReference.findUnique({ where: { id }, include: { tag: { include } } })
      if (ref) {
        if (ref.tag.userId !== userId) throw new Error('TAG_OWNER')
        return ref.tag
      }
      const existing = await db.tag.findUnique({
        where: { userId_normalizedName: { userId, normalizedName: name.toLowerCase() } }
      })
      if (existing) {
        await db.tagReference.create({ data: { id, tagId: existing.id } })
        return db.tag.findUniqueOrThrow({ where: { id: existing.id }, include })
      }
      const last = await db.tag.aggregate({ where: { userId }, _max: { position: true } })
      return db.tag.create({
        data: {
          id,
          userId,
          name,
          normalizedName: name.toLowerCase(),
          position: (last._max.position ?? -1) + 1,
          references: { create: { id } }
        },
        include
      })
    })
    res.status(201).json(visible(tag))
  } catch (error) {
    if ((error as Error).message === 'TAG_OWNER')
      return res.status(404).json({ error: 'Tag not found.' })
    if (isUniqueViolation(error))
      return res.status(409).json({ error: 'The tag changed. Refresh and retry.' })
    next(error)
  }
})
tagsRouter.put('/order', async (req: AuthRequest, res, next) => {
  const ids = req.body?.ids
  if (!Array.isArray(ids) || !ids.every(validTagId) || new Set(ids).size !== ids.length)
    return res.status(400).json({ error: 'A unique list of tag ids is required.' })
  try {
    const result = await prisma.$transaction(async db => {
      const all = await db.tag.findMany({
        where: { userId: req.userId! },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        include
      })
      const refs = await db.tagReference.findMany({
        where: { id: { in: ids }, tag: { userId: req.userId! } }
      })
      if (refs.length !== ids.length) return null
      const canonical = [...new Set(ids.map(id => refs.find(ref => ref.id === id)!.tagId))]
      const ordered = [
        ...canonical,
        ...all.filter(tag => !canonical.includes(tag.id)).map(tag => tag.id)
      ]
      for (let position = 0; position < ordered.length; position++)
        await db.tag.update({ where: { id: ordered[position] }, data: { position } })
      return db.tag.findMany({
        where: { userId: req.userId! },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        include
      })
    })
    if (!result)
      return res.status(400).json({ error: 'A tag no longer exists. Refresh the catalog.' })
    res.json(result.map(visible))
  } catch (error) {
    next(error)
  }
})
tagsRouter.put('/:id', async (req: AuthRequest, res, next) => {
  const name = tagName(req.body?.name)
  if (!name) return res.status(400).json({ error: 'Tag name must contain 1–20 characters.' })
  try {
    const ref = await prisma.tagReference.findFirst({
      where: { id: String(req.params.id), tag: { userId: req.userId! } }
    })
    if (!ref) return res.status(404).json({ error: 'Tag not found.' })
    res.json(
      visible(
        await prisma.tag.update({
          where: { id: ref.tagId },
          data: { name, normalizedName: name.toLowerCase() },
          include
        })
      )
    )
  } catch (error) {
    if (isUniqueViolation(error))
      return res.status(409).json({ error: 'A tag with that name already exists.' })
    next(error)
  }
})
tagsRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const ref = await prisma.tagReference.findFirst({
      where: { id: String(req.params.id), tag: { userId: req.userId! } }
    })
    if (!ref) return res.status(404).json({ error: 'Tag not found.' })
    await prisma.$transaction(async db => {
      await db.transaction.updateMany({
        where: { userId: req.userId!, tags: { some: { tagId: ref.tagId } } },
        data: { editedAt: new Date(), lastEditId: randomUUID() }
      })
      const favorites = await db.favorite.findMany({ where: { userId: req.userId! } })
      for (const favorite of favorites) {
        const ids = JSON.parse(favorite.tagIds) as string[]
        if (ids.includes(ref.tagId))
          await db.favorite.update({
            where: { id: favorite.id },
            data: { tagIds: JSON.stringify(ids.filter(id => id !== ref.tagId)) }
          })
      }
      await db.tag.delete({ where: { id: ref.tagId } })
    })
    res.json({ success: true })
  } catch (error) {
    next(error)
  }
})
