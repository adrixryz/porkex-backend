import type { Prisma } from '@prisma/client'
import { parseInstant } from './dates'
import { FinanceError } from './finance'

/** A receipt deduplicates one save; this stamp orders distinct saves across devices. */
export async function acceptFinancialEdit(
  db: Prisma.TransactionClient,
  userId: number,
  key: string,
  body: { editedAt?: unknown; mutationId?: unknown }
) {
  const editedAt = parseInstant(body.editedAt)
  const mutationId = body.mutationId
  if (!editedAt || typeof mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(mutationId))
    throw new FinanceError('Update Porkex and explicitly retry this older edit before saving.', 428)
  if (editedAt.getTime() > Date.now() + 5 * 60_000)
    throw new FinanceError('Enable automatic date and time before retrying this edit.')
  const previous = await db.financialEdit.findUnique({ where: { userId_key: { userId, key } } })
  if (
    previous &&
    (editedAt < previous.editedAt ||
      (editedAt.getTime() === previous.editedAt.getTime() && mutationId < previous.mutationId))
  )
    throw new FinanceError(
      'A newer change was already saved. Refresh this item before editing it again.',
      409
    )
  await db.financialEdit.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, editedAt, mutationId },
    update: { editedAt, mutationId }
  })
  return editedAt
}
