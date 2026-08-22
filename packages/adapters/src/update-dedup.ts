/**
 * One delivery of one message must produce one run of the pipeline.
 *
 * MTProto is an at-least-once channel. When the connection stalls, mtcute
 * recovers the gap with `getChannelDifference`, and the server answers from the
 * stored `pts` — not from whether our handler had already finished with those
 * messages. So a message delivered live can arrive a second time through
 * recovery, and the handler has no way to tell the two apart.
 *
 * mtcute does keep an anti-duplicate index, but only for the COMMON update
 * path: `_recentlyDispatchedCommonMsgs` is filled from `updateNewMessage` and
 * consulted in the `updates.getDifference` branch (core 0.31,
 * highlevel/updates/manager.js). Supergroups deliver `updateNewChannelMessage`
 * and recover through `getChannelDifference`, which has no such index. Every
 * chat this bot moderates is a supergroup, so none of them are covered.
 *
 * Production 2026-08-21: one joiner was greeted twelve times in seven minutes,
 * in four bursts of exactly three greetings ~110 ms apart, ending in
 * `photos.getUserPhotos resulted in a flood wait`. The same log carries
 * `read timeout, last read was 10842ms ago` on the download connection — the
 * connection instability that sends mtcute into gap recovery.
 *
 * Guarding here rather than in any one handler is the point: a duplicate
 * delivery otherwise costs a duplicate greeting, a duplicate avatar download, a
 * duplicate moderation call and a duplicate verdict, and each handler would
 * need its own defence against the same transport fact.
 */

/** Bounded, time-limited memory of deliveries already handed to the pipeline. */
export interface UpdateDedup {
  /**
   * Records the delivery and reports whether it is the first one.
   *
   * Claiming BEFORE the handler runs, not after, is deliberate: duplicates
   * arrive milliseconds apart and concurrently, so a mark written on completion
   * would be written far too late to stop the second one. Nothing redelivers an
   * update whose handler threw, so there is no retry for the claim to swallow.
   */
  claim(key: string): boolean
  /** Entries currently held — for tests and diagnostics. */
  size(): number
}

export interface UpdateDedupOptions {
  /**
   * Capacity. Sized as peak messages/hour × TTL with room to spare: the cost of
   * being too small is the silent return of the bug, and the cost of being too
   * large is a few megabytes.
   */
  maxEntries?: number
  /**
   * How long a delivery stays remembered. Gap recovery follows a disconnect by
   * seconds to minutes; an hour is far past that.
   */
  ttlMs?: number
  now?: () => number
}

export const UPDATE_DEDUP_MAX_ENTRIES = 100_000
export const UPDATE_DEDUP_TTL_MS = 60 * 60 * 1000

/**
 * Identity of one delivery.
 *
 * `isEdit` is part of the key, not a filter: an edit of a message we already
 * processed is a real second event about the same id, and must not be dropped
 * because the original was seen.
 *
 * `editDate` versions the EDIT stream only. Successive edits of one message are
 * separate events and each deserves a run; Telegram stamps the date per edit, at
 * second resolution, so two edits inside the same second collapse into one
 * re-evaluation of near-identical text — the harmless direction.
 *
 * It is deliberately left out of the arrival key. A message is new exactly once,
 * and a redelivery through gap recovery carries whatever `editDate` the message
 * has acquired since; including it there would make the recovered copy look like
 * a different arrival and defeat the whole guard.
 */
export const deliveryKey = (
  chatId: number,
  messageId: number,
  isEdit: boolean,
  editDate: Date | null
): string => isEdit
  ? `e:${chatId}:${messageId}:${editDate ? editDate.getTime() : 0}`
  : `n:${chatId}:${messageId}`

export const createUpdateDedup = (options: UpdateDedupOptions = {}): UpdateDedup => {
  const maxEntries = options.maxEntries ?? UPDATE_DEDUP_MAX_ENTRIES
  const ttlMs = options.ttlMs ?? UPDATE_DEDUP_TTL_MS
  const now = options.now ?? (() => Date.now())

  const seen = new Map<string, number>()

  return {
    claim(key: string): boolean {
      const at = now()
      const expiresAt = seen.get(key)
      if (expiresAt !== undefined) {
        if (expiresAt > at) return false
        // Expired: this is a genuinely new delivery reusing an old key.
        seen.delete(key)
      }
      seen.set(key, at + ttlMs)
      // Insertion order is eviction order — the same bound `chat-profile.ts`
      // uses. Entries are never re-inserted on a hit (a hit returns above), so
      // order here is arrival order and the oldest delivery is dropped first.
      while (seen.size > maxEntries) {
        const oldest = seen.keys().next()
        if (oldest.done) break
        seen.delete(oldest.value)
      }
      return true
    },
    size: () => seen.size
  }
}
