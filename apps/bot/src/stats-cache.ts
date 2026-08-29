/**
 * A small read-through cache for figures that are expensive to count and cheap
 * to be slightly stale.
 *
 * `/stats` scans a fortnight of decisions — around a second of Mongo per call,
 * on a free-tier cluster shared with moderation itself. The card is an advert,
 * not a dashboard: ten-minute-old counts are indistinguishable from live ones to
 * the person reading them, and a scan per tap would take time away from the work
 * the numbers are bragging about.
 *
 * Three properties matter beyond the caching, and each is a defect this bot has
 * shipped before in some other shape:
 *  - a failed read serves the last good answer, because a card of zeros claims
 *    the bot has done nothing;
 *  - concurrent callers share one read, because a chat can produce several taps
 *    inside one round trip;
 *  - entries are bounded, because there is one key per chat and this bot is in
 *    hundreds of them.
 */
export interface StatsCache<T> {
  /** The cached value, a fresh read, or null when we have never had one. */
  get: (key: string) => Promise<T | null>
  /** Entries currently held. Exposed for the eviction test, not for callers. */
  size: () => number
}

interface Entry<T> {
  value: T | null
  /** When `value` was read. Stale entries are refreshed, not dropped. */
  readAt: number
  /** In-flight read, shared by every caller that arrives while it runs. */
  loading: Promise<T | null> | null
}

export const createStatsCache = <T>(options: {
  ttlMs: number
  load: (key: string) => Promise<T>
  maxEntries?: number
  now?: () => number
}): StatsCache<T> => {
  const { ttlMs, load, maxEntries = 512, now = Date.now } = options
  // Insertion-ordered, so the first key is always the oldest — Map gives us the
  // eviction order for free.
  const entries = new Map<string, Entry<T>>()

  const refresh = async (key: string, entry: Entry<T>): Promise<T | null> => {
    try {
      const value = await load(key)
      entry.value = value
      entry.readAt = now()
      return value
    } catch {
      // Keep whatever we had. A stale truth outlives a fresh blank, and the
      // next caller past the TTL will try again.
      return entry.value
    } finally {
      entry.loading = null
    }
  }

  return {
    async get(key) {
      const existing = entries.get(key)
      if (existing) {
        if (existing.loading) return existing.loading
        if (now() - existing.readAt < ttlMs) return existing.value
        existing.loading = refresh(key, existing)
        return existing.loading
      }
      const entry: Entry<T> = { value: null, readAt: 0, loading: null }
      entries.set(key, entry)
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next()
        if (!oldest.done && oldest.value !== key) entries.delete(oldest.value)
      }
      entry.loading = refresh(key, entry)
      return entry.loading
    },
    size: () => entries.size
  }
}
