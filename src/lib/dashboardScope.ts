import { prisma } from './prisma'

/** Account scope for Dashboard Total, including legacy rows belonging to Main. */
export async function dashboardAccountScope(userId: number) {
  const accounts = await prisma.account.findMany({
    where: { userId, excludeFromTotalBalance: false },
    select: { id: true, isMain: true }
  })
  return [
    { accountId: { in: accounts.map(account => account.id) } },
    ...(accounts.some(account => account.isMain) ? [{ accountId: null }] : [])
  ]
}
