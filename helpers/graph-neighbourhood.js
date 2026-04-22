/**
 * Graph-neighbourhood taint.
 *
 * Farm accounts often appear together: when the bot catches and bans one,
 * its "siblings" are usually in the same chats and have similar join-time
 * proximity. We surface this without maintaining a persistent graph —
 * everything is computed on demand from the session/DB we already have.
 *
 * How the signal works:
 *   - When a user is banned (globalBan or reputation.restricted), we note
 *     (userId, chats, banTime) in a short-lived in-memory buffer.
 *   - When ANY new user is being scored, we check: do they share chats
 *     with a recently-banned user AND did they first-see in those chats
 *     within a short window around that user's firstSeen? If yes → taint.
 *
 * The buffer holds last 500 bans with TTL 7d. This is intentionally small
 * — cross-user correlation only matters for the hottest recent attacks.
 *
 * Signal tiers:
 *   - `graph_neighbour_recent_ban`: 1+ chat overlap + joined within 24h
 *     of a recently-banned user → soft signal, informs other rules.
 *   - `graph_coordinated_join`: 2+ chat overlap + <1h join gap → strong
 *     signal, combined with any promo = spam.
 */

const BAN_BUFFER_SIZE = 500
const BAN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const NEIGHBOUR_JOIN_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h for soft tier
const COORDINATED_JOIN_WINDOW_MS = 60 * 60 * 1000 // 1h for strong tier

// Ring buffer of recent bans. Each entry: { userId, chats:Set, firstSeenAt, bannedAt }
const recentBans = []

const pruneBans = (now = Date.now()) => {
  let i = 0
  while (i < recentBans.length) {
    if (now - recentBans[i].bannedAt > BAN_TTL_MS) recentBans.splice(i, 1)
    else i++
  }
}

/**
 * Register a freshly-banned user. Call this from reputation.processSpamAction
 * when globalBanApplied fires (or when status flips to restricted).
 */
const registerBan = (userId, { chats, firstSeenAt }) => {
  if (!userId) return
  const now = Date.now()
  pruneBans(now)
  recentBans.push({
    userId,
    chats: new Set(Array.isArray(chats) ? chats : []),
    firstSeenAt: firstSeenAt instanceof Date ? firstSeenAt.getTime() : Number(firstSeenAt) || now,
    bannedAt: now
  })
  while (recentBans.length > BAN_BUFFER_SIZE) recentBans.shift()
}

/**
 * Check if a given user sits in the neighbourhood of any recent ban.
 *
 * @param {Object} candidate  { userId, chats, firstSeenAt }
 * @returns {null | { tier, sharedBanUserId, sharedChats, joinGapMs }}
 */
const queryNeighbourhood = (candidate) => {
  if (!candidate || !candidate.userId) return null
  const now = Date.now()
  pruneBans(now)

  const candChats = new Set(Array.isArray(candidate.chats) ? candidate.chats : [])
  const candFirstSeen = candidate.firstSeenAt instanceof Date
    ? candidate.firstSeenAt.getTime()
    : Number(candidate.firstSeenAt) || now
  if (candChats.size === 0) return null

  let bestSoft = null
  let bestStrong = null
  for (const ban of recentBans) {
    if (ban.userId === candidate.userId) continue

    // Chat overlap
    let sharedCount = 0
    for (const c of candChats) if (ban.chats.has(c)) sharedCount++
    if (sharedCount === 0) continue

    const gap = Math.abs(candFirstSeen - ban.firstSeenAt)
    if (sharedCount >= 2 && gap <= COORDINATED_JOIN_WINDOW_MS) {
      if (!bestStrong || bestStrong.sharedChats < sharedCount) {
        bestStrong = { tier: 'coordinated', sharedBanUserId: ban.userId, sharedChats: sharedCount, joinGapMs: gap }
      }
    } else if (sharedCount >= 1 && gap <= NEIGHBOUR_JOIN_WINDOW_MS) {
      if (!bestSoft || bestSoft.sharedChats < sharedCount) {
        bestSoft = { tier: 'neighbour', sharedBanUserId: ban.userId, sharedChats: sharedCount, joinGapMs: gap }
      }
    }
  }
  return bestStrong || bestSoft
}

const _resetForTests = () => {
  recentBans.length = 0
}

module.exports = {
  registerBan,
  queryNeighbourhood,
  BAN_BUFFER_SIZE,
  BAN_TTL_MS,
  NEIGHBOUR_JOIN_WINDOW_MS,
  COORDINATED_JOIN_WINDOW_MS,
  _resetForTests
}
