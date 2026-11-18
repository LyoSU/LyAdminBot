/**
 * Per-sender message rate for the chat filters' flood limit.
 *
 * Memory-only, like the other short windows in this app: a minute of history
 * lost to a restart costs one flood that gets through, and persisting every
 * message's timestamp for that would cost writes on the hottest path we have.
 * One delivery is one message — the gateway folds an album into a single
 * delivery before it reaches here, so ten photos sent together count once.
 */

/** The longest window any flood preset uses; nothing older is ever asked for. */
export const FLOOD_WINDOW_MAX_MS = 60_000

/** Bound on tracked chat+sender pairs: a raid of throwaway accounts cannot grow this without limit. */
export const FLOOD_TRACKED_MAX = 20_000

export class FloodTracker {
  private readonly hits = new Map<string, number[]>()

  constructor(private readonly maxKeys: number = FLOOD_TRACKED_MAX) {}

  /**
   * Record one message and return how many this sender posted in the chat
   * within `windowMs`, this one included.
   */
  note(chatId: number, userId: number, at: number, windowMs: number): number {
    const key = `${chatId}:${userId}`
    const since = at - Math.min(windowMs, FLOOD_WINDOW_MAX_MS)
    const kept = (this.hits.get(key) ?? []).filter((t) => t > at - FLOOD_WINDOW_MAX_MS)
    kept.push(at)
    // Re-inserted so the map's order is least-recently-active first.
    this.hits.delete(key)
    this.hits.set(key, kept)
    if (this.hits.size > this.maxKeys) this.evict(at)
    return kept.filter((t) => t > since).length
  }

  get size(): number { return this.hits.size }

  private evict(now: number): void {
    for (const [key, times] of this.hits) {
      if (this.hits.size <= this.maxKeys) return
      // Oldest activity first, so a live sender is the last to lose its count.
      if (times.every((t) => t <= now - FLOOD_WINDOW_MAX_MS) || this.hits.size > this.maxKeys) {
        this.hits.delete(key)
      }
    }
  }
}
