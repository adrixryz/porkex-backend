import { dayKey } from './dates'

export type RecurringResult = { created: number; state: 'ready' | 'pending' }

/** Cache only settled schedules; invalidation also separates work already in flight. */
export function createRecurringCache(
  materialize: (userId: number, today: Date) => Promise<RecurringResult>,
  clock = Date.now,
  ttlMs = 30_000
) {
  const generations = new Map<number, number>()
  const ready = new Map<string, { userId: number; expires: number }>()
  const running = new Map<string, Promise<RecurringResult>>()
  return {
    invalidate(userId: number) {
      generations.set(userId, (generations.get(userId) ?? 0) + 1)
      for (const [key, entry] of ready) if (entry.userId === userId) ready.delete(key)
    },
    run(userId: number, today: Date, zone: string): Promise<RecurringResult> {
      const now = clock()
      for (const [key, entry] of ready) if (entry.expires <= now) ready.delete(key)
      const generation = generations.get(userId) ?? 0
      const key = `${userId}:${dayKey(today)}:${zone}:${generation}`
      if (ready.has(key)) return Promise.resolve({ created: 0, state: 'ready' })
      const existing = running.get(key)
      if (existing) return existing
      const work = materialize(userId, today)
        .then(result => {
          if (result.state === 'ready' && (generations.get(userId) ?? 0) === generation)
            ready.set(key, { userId, expires: clock() + ttlMs })
          return result
        })
        .finally(() => running.delete(key))
      running.set(key, work)
      return work
    }
  }
}
