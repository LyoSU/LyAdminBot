import { noVotersShadowStamp, type NoVotersShadowStamp } from '@lyadmin/core'

/**
 * The per-chat lookup behind the no-voters shadow (see `noVotersShadowStamp`).
 *
 * Production 2026-10-14/15 opened on the order of a hundred bot questions a
 * day across a few dozen chats, so one read per question is cheap but one read
 * per chat per hour is cheaper, and an hour cannot move "nobody voted here in
 * seven days" by more than the one question that just opened. The cache is
 * keyed by chat only: the value is computed with the triggering question
 * excluded, and every later question in the hour rightly counts that one.
 *
 * A failed read is NOT a zero — "unknown" stamped as "nobody votes" would
 * inflate the very number this measures — so it stamps nothing and is not
 * cached.
 */
export const NO_VOTERS_CACHE_TTL_MS = 60 * 60_000

export const createNoVotersShadow = (deps: {
  load: (chatId: number, excludeMessageId: number) => Promise<number>
  stamp: (chatId: number, messageId: number, stamp: NoVotersShadowStamp) => Promise<void>
  onNoVoters?: (chatId: number, messageId: number, stamp: NoVotersShadowStamp) => void
  now?: () => number
  ttlMs?: number
  maxEntries?: number
}): ((chatId: number, messageId: number) => Promise<NoVotersShadowStamp | null>) => {
  const { load, stamp, onNoVoters, now = Date.now, ttlMs = NO_VOTERS_CACHE_TTL_MS, maxEntries = 1024 } = deps
  const cache = new Map<number, { voters: number; at: number }>()
  return async (chatId, messageId) => {
    let voters: number
    const hit = cache.get(chatId)
    if (hit && now() - hit.at < ttlMs) {
      voters = hit.voters
    } else {
      try {
        voters = await load(chatId, messageId)
      } catch {
        return null
      }
      cache.delete(chatId)
      cache.set(chatId, { voters, at: now() })
      if (cache.size > maxEntries) {
        const oldest = cache.keys().next()
        if (!oldest.done) cache.delete(oldest.value)
      }
    }
    const result = noVotersShadowStamp(voters)
    await stamp(chatId, messageId, result)
    if (result.shadowNoVoters) onNoVoters?.(chatId, messageId, result)
    return result
  }
}
