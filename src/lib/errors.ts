// Prisma reports a unique constraint violation with this code. It is what turns
// a lost race into a deterministic answer: two requests that both passed their
// "does it exist?" check collide here, and the loser is told 409 instead of 500.
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002'
}
