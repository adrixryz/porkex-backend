import type { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { catalogName } from './catalogNames'

export const tagInclude = { tags: { include: { tag: true } } } as const
export function commentInput(body: Record<string, unknown>): string | null {
  const value = body.comment !== undefined ? body.comment : body.description
  if (value === undefined || value === null) return ''
  return typeof value === 'string' && value.trim().length <= 200 ? value.trim() : null
}
export function tagName(value: unknown): string | null {
  return catalogName(value, 20)
}
export function validTagId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}
export async function resolveTagIds(
  userId: number,
  value: unknown,
  db: Prisma.TransactionClient = prisma
): Promise<string[] | null> {
  if (
    !Array.isArray(value) ||
    value.length > 5 ||
    !value.every(validTagId) ||
    new Set(value).size !== value.length
  )
    return null
  const refs = await db.tagReference.findMany({ where: { id: { in: value }, tag: { userId } } })
  if (refs.length !== value.length) return null
  return [...new Set(refs.map(ref => ref.tagId))]
}
