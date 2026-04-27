/**
 * Network-level detectors — run over in-memory state that spans multiple
 * users / chats in a short window. Persistence lives in the MediaFingerprint
 * model (for media) and the User doc (for emoji IDs); this module does the
 * fast cross-user lookups.
 *
 * Two detectors live here:
 *
 *   1. Custom-emoji cluster
 *      Telegram Premium users can set `custom_emoji` entities referring to
 *      pack-specific emoji IDs (stable UUIDs). Coordinated spam networks
 *      buy the same Premium emoji pack and seed their messages with it —
 *      an identifier you can cross-reference across otherwise-unrelated
 *      accounts. Real users occasionally share a favourite emoji too, so
 *      we only flag when many suspicious accounts share the same ID in a
 *      narrow window.
 *
 *   2. Chat-level new-user burst
 *      A 15-minute sliding window of "first-messages in this chat from
 *      new-to-us users". If >= 3 distinct users first-post with similar
 *      content inside the window, it's almost always a coordinated attack
 *      (3 accounts spun up to amplify the same promo). Similarity is the
 *      simHash Hamming distance from velocity.js — we just reuse it.
 *
 * Both structures are pure in-memory with TTL sweepers. No disk, no DB.
 * Crash-resilient because the signal value is in the CURRENT window; if
 * we lose state on restart we lose at most the tail of a short burst.
 */

const { velocity: velocityLog } = require('./logger')
const { safeInterval } = require('./timers')
const { getSimHash } = require('./velocity')
const { hasTextualContent } = require('./text-utils')
const { dhashFromFileId, hammingDistance: dhashHamming } = require('./image-hash')

// ---------------------------------------------------------------------------
// Custom emoji cluster
// ---------------------------------------------------------------------------

const EMOJI_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h sliding window
const EMOJI_BURST_USER_THRESHOLD = 3 // 3+ distinct users sharing = cluster
// Map<emojiId, { users: Set<userId>, lastSeenAt: number }>
const emojiClusters = new Map()

/**
 * Record occurrences of custom-emoji IDs in a user's message. Returns the
 * list of emoji IDs that have now hit the cluster threshold (i.e. 3+ users
 * share this emoji within EMOJI_WINDOW_MS).
 */
const recordCustomEmojiUse = (userId, emojiIds) => {
  if (!userId || !Array.isArray(emojiIds) || emojiIds.length === 0) return []
  const now = Date.now()
  const clusters = []
  for (const id of emojiIds) {
    if (!id || typeof id !== 'string') continue
    let entry = emojiClusters.get(id)
    if (!entry) {
      entry = { users: new Set(), lastSeenAt: now, firstSeenAt: now }
      emojiClusters.set(id, entry)
    }
    // Purge stale (outside window) — simple lazy expiry
    if (now - entry.lastSeenAt > EMOJI_WINDOW_MS) {
      entry.users = new Set()
      entry.firstSeenAt = now
    }
    entry.users.add(userId)
    entry.lastSeenAt = now
    if (entry.users.size >= EMOJI_BURST_USER_THRESHOLD) {
      clusters.push({ id, users: entry.users.size, windowMs: now - entry.firstSeenAt })
    }
  }
  return clusters
}

/**
 * Quick read: does this user share a custom_emoji ID with a cluster of
 * other suspicious users? (Used as a soft signal, not a verdict on its
 * own — legitimate people use popular emoji packs.)
 */
const queryEmojiCluster = (emojiIds) => {
  if (!Array.isArray(emojiIds)) return { clustered: false, topCount: 0 }
  let topCount = 0
  for (const id of emojiIds) {
    const entry = emojiClusters.get(id)
    if (entry && entry.users.size > topCount) topCount = entry.users.size
  }
  return { clustered: topCount >= EMOJI_BURST_USER_THRESHOLD, topCount }
}

// Periodic sweep — runs every 6h, drops entries idle for > window * 2
if (typeof setInterval === 'function') {
  safeInterval(() => {
    const now = Date.now()
    for (const [id, entry] of emojiClusters) {
      if (now - entry.lastSeenAt > 2 * EMOJI_WINDOW_MS) emojiClusters.delete(id)
    }
  }, 6 * 60 * 60 * 1000, { log: velocityLog, label: 'emoji-cluster-sweep' })
}

// ---------------------------------------------------------------------------
// Chat-level new-user burst
// ---------------------------------------------------------------------------

const BURST_WINDOW_MS = 15 * 60 * 1000 // 15min
const BURST_USER_THRESHOLD = 3 // 3+ new users first-posting in window
// simHash is 64-bit (16 hex nibbles). Natural noise between paraphrased
// spam templates is around 8-12 bits; we set the cluster threshold at 10
// to catch common rewording without overfitting to exact templates.
const BURST_SIMHASH_HAMMING_THRESHOLD = 10
const BURST_MAX_ENTRIES_PER_CHAT = 30

// Map<chatId, Array<{ userId, firstMsgAt, simHash }>>
const chatBurstQueue = new Map()

const pruneBurstQueue = (entries, now) => {
  const cutoff = now - BURST_WINDOW_MS
  while (entries.length && entries[0].firstMsgAt < cutoff) entries.shift()
}

/**
 * Hamming distance between two hex simhash strings (nibble-wise).
 * Mirrors velocity.hammingDistance but we re-implement to avoid coupling.
 */
const hamming = (a, b) => {
  if (!a || !b) return Infinity
  const len = Math.min(a.length, b.length)
  let d = 0
  for (let i = 0; i < len; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    d += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1)
  }
  return d
}

/**
 * Record a first-message observation for this chat. Returns a burst
 * descriptor when the window contains enough other recent first-messages
 * that match the current one's structure (same simHash bucket or close).
 *
 * "First message" means: the user's first observable message in THIS chat
 * — typically messageCount <= 1. The caller decides when to treat a
 * message as first; we just bucket what's handed to us.
 *
 * @param {number} chatId
 * @param {number} userId
 * @param {string} text       Message text (for simHash; null for media-only)
 * @returns {null | { burstSize:number, users:number[], windowMs:number, matchedSimHash:string }}
 */
const recordChatFirstMessage = (chatId, userId, text) => {
  if (!chatId || !userId) return null
  const now = Date.now()
  const hash = (text && hasTextualContent(text)) ? getSimHash(text) : null
  const entry = { userId, firstMsgAt: now, simHash: hash }

  if (!chatBurstQueue.has(chatId)) chatBurstQueue.set(chatId, [])
  const entries = chatBurstQueue.get(chatId)
  pruneBurstQueue(entries, now)
  entries.push(entry)
  if (entries.length > BURST_MAX_ENTRIES_PER_CHAT) entries.shift()

  if (entries.length < BURST_USER_THRESHOLD) return null

  // Connected-component clustering over all entries in the window.
  // Two entries are "connected" if either:
  //   - both have textual simHash and Hamming distance <= threshold, or
  //   - both are media-only (null hash) — observed in prod as coordinated
  //     photo-drop attacks from fresh accounts in the same window.
  // This transitive closure is what we want: a genuine coordinated wave
  // often has rewritten templates where A ~ B and B ~ C but not A ~ C,
  // and a single-anchor clustering misses the whole component.
  const parent = new Map()
  const find = (x) => {
    if (parent.get(x) === x) return x
    const r = find(parent.get(x))
    parent.set(x, r)
    return r
  }
  const union = (a, b) => {
    const ra = find(a); const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (let i = 0; i < entries.length; i++) parent.set(i, i)
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]; const b = entries[j]
      const connected = (a.simHash && b.simHash &&
          hamming(a.simHash, b.simHash) <= BURST_SIMHASH_HAMMING_THRESHOLD) ||
        (!a.simHash && !b.simHash)
      if (connected) union(i, j)
    }
  }
  // Current user's component
  const currentIdx = entries.findIndex(e => e.userId === userId && e.firstMsgAt === entry.firstMsgAt)
  const myRoot = find(currentIdx >= 0 ? currentIdx : entries.length - 1)
  const componentUsers = new Set()
  for (let i = 0; i < entries.length; i++) {
    if (find(i) === myRoot) componentUsers.add(entries[i].userId)
  }

  if (componentUsers.size >= BURST_USER_THRESHOLD) {
    return {
      burstSize: componentUsers.size,
      users: Array.from(componentUsers),
      windowMs: now - entries[0].firstMsgAt,
      matchedSimHash: hash
    }
  }
  return null
}

// Periodic sweep — drop entries older than window * 4 and empty chats
if (typeof setInterval === 'function') {
  safeInterval(() => {
    const now = Date.now()
    for (const [chatId, entries] of chatBurstQueue) {
      pruneBurstQueue(entries, now)
      if (entries.length === 0) chatBurstQueue.delete(chatId)
    }
  }, 30 * 60 * 1000, { log: velocityLog, label: 'chat-burst-queue-sweep' })
}

// ---------------------------------------------------------------------------
// Test helpers (exported only for test / ops use; not imported in prod code)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sticker pack fingerprint
// ---------------------------------------------------------------------------
//
// Telegram sticker messages carry `sticker.set_name` — a stable identifier
// for the pack the sticker belongs to. Spam/scam operators often create
// dedicated packs (e.g. "earn_money_pack", "scam_crypto") and seed them
// across their account farm. Tracking cross-user set_name reuse surfaces
// the network without needing to hash individual stickers.
//
// Behaviour: Map<setName, Set<userId>>. 24h window. Cluster threshold 3
// distinct users — the same pack from 3+ "different" users within a day
// is a strong pack-as-identifier signal. Real human sharing of popular
// packs is rarer than you'd think: most users stick to default packs that
// change content over time, so novel set_name values repeated quickly are
// suspicious by themselves.

const STICKER_PACK_WINDOW_MS = 24 * 60 * 60 * 1000
const STICKER_PACK_USER_THRESHOLD = 3
const stickerPackClusters = new Map()

const recordStickerPack = (userId, setName) => {
  if (!userId || !setName) return null
  const now = Date.now()
  let entry = stickerPackClusters.get(setName)
  if (!entry) {
    entry = { users: new Set(), firstSeenAt: now, lastSeenAt: now }
    stickerPackClusters.set(setName, entry)
  }
  if (now - entry.lastSeenAt > STICKER_PACK_WINDOW_MS) {
    entry.users = new Set()
    entry.firstSeenAt = now
  }
  entry.users.add(userId)
  entry.lastSeenAt = now
  if (entry.users.size >= STICKER_PACK_USER_THRESHOLD) {
    return { setName, users: entry.users.size, windowMs: now - entry.firstSeenAt }
  }
  return null
}

const queryStickerPack = (setName) => {
  if (!setName) return { clustered: false, userCount: 0 }
  const entry = stickerPackClusters.get(setName)
  if (!entry) return { clustered: false, userCount: 0 }
  return {
    clustered: entry.users.size >= STICKER_PACK_USER_THRESHOLD,
    userCount: entry.users.size
  }
}

if (typeof setInterval === 'function') {
  safeInterval(() => {
    const now = Date.now()
    for (const [name, entry] of stickerPackClusters) {
      if (now - entry.lastSeenAt > 2 * STICKER_PACK_WINDOW_MS) stickerPackClusters.delete(name)
    }
  }, 6 * 60 * 60 * 1000, { log: velocityLog, label: 'sticker-pack-cluster-sweep' })
}

// ---------------------------------------------------------------------------
// Profile photo perceptual hash clustering
// ---------------------------------------------------------------------------
//
// Account farms often reuse stolen or AI-generated profile photos across
// dozens of accounts. We capture the first-sighted user's profile photo,
// dhash it, and maintain an in-memory index. When a new user first appears
// and their photo's dhash matches (Hamming <= 10) an existing cluster, we
// emit a signal.
//
// Cost amortisation: profile photo is fetched ONCE per user (cached in
// profilePhotoByUser). The actual dhash is cheap; the network hop to
// download the image is the cost, which we only pay for unseen users.
//
// Time bound: entries expire 7d after last sighting to prevent unbounded
// memory growth for long-running instances.

const PROFILE_PHOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PROFILE_PHOTO_CLUSTER_THRESHOLD = 3
const PROFILE_PHOTO_MATCH_HAMMING = 10

// Map<userId, { hash, seenAt }>
const profilePhotoByUser = new Map()
// Array of cluster entries: { hash, users: Set<userId>, seenAt }
const profilePhotoClusters = []

const recordProfilePhotoHash = (userId, hash) => {
  if (!userId || typeof hash !== 'string') return null
  const now = Date.now()
  profilePhotoByUser.set(userId, { hash, seenAt: now })

  // Find or create cluster
  let targetCluster = null
  for (const c of profilePhotoClusters) {
    if (dhashHamming(c.hash, hash) <= PROFILE_PHOTO_MATCH_HAMMING) {
      targetCluster = c
      break
    }
  }
  if (!targetCluster) {
    targetCluster = { hash, users: new Set(), seenAt: now }
    profilePhotoClusters.push(targetCluster)
  }
  targetCluster.users.add(userId)
  targetCluster.seenAt = now

  if (targetCluster.users.size >= PROFILE_PHOTO_CLUSTER_THRESHOLD) {
    return { clusterUsers: targetCluster.users.size, hash: targetCluster.hash }
  }
  return null
}

/**
 * Attempt to cache + cluster this user's profile photo. Called on first
 * sighting of a user (expensive — network hop). Returns a cluster verdict
 * if the user's photo matches 3+ others.
 */
const fetchAndClusterProfilePhoto = async (telegram, userId) => {
  if (!telegram || !userId) return null
  // Short-circuit if we already hashed this user recently.
  const cached = profilePhotoByUser.get(userId)
  if (cached && Date.now() - cached.seenAt < PROFILE_PHOTO_TTL_MS) {
    return null
  }
  try {
    const photos = await telegram.getUserProfilePhotos(userId, 0, 1)
    if (!photos || !photos.photos || photos.photos.length === 0) return null
    const smallest = photos.photos[0][0]
    if (!smallest || !smallest.file_id) return null
    const hash = await dhashFromFileId(telegram, smallest.file_id)
    if (!hash) return null
    return recordProfilePhotoHash(userId, hash)
  } catch (_err) {
    return null
  }
}

if (typeof setInterval === 'function') {
  safeInterval(() => {
    const now = Date.now()
    for (const [uid, entry] of profilePhotoByUser) {
      if (now - entry.seenAt > 2 * PROFILE_PHOTO_TTL_MS) profilePhotoByUser.delete(uid)
    }
    // Prune stale clusters
    const alive = []
    for (const c of profilePhotoClusters) {
      if (now - c.seenAt <= 2 * PROFILE_PHOTO_TTL_MS) alive.push(c)
    }
    profilePhotoClusters.length = 0
    profilePhotoClusters.push(...alive)
  }, 12 * 60 * 60 * 1000, { log: velocityLog, label: 'profile-photo-sweep' })
}

const _resetForTests = () => {
  emojiClusters.clear()
  chatBurstQueue.clear()
  stickerPackClusters.clear()
  profilePhotoByUser.clear()
  profilePhotoClusters.length = 0
}

try { if (velocityLog) { /* touch for coverage */ } } catch (_e) { /* ignore */ }

module.exports = {
  // Custom emoji cluster
  recordCustomEmojiUse,
  queryEmojiCluster,
  EMOJI_WINDOW_MS,
  EMOJI_BURST_USER_THRESHOLD,

  // Chat burst
  recordChatFirstMessage,
  BURST_WINDOW_MS,
  BURST_USER_THRESHOLD,
  BURST_SIMHASH_HAMMING_THRESHOLD,

  // Sticker pack fingerprint
  recordStickerPack,
  queryStickerPack,
  STICKER_PACK_WINDOW_MS,
  STICKER_PACK_USER_THRESHOLD,

  // Profile photo pHash clustering
  recordProfilePhotoHash,
  fetchAndClusterProfilePhoto,
  PROFILE_PHOTO_TTL_MS,
  PROFILE_PHOTO_CLUSTER_THRESHOLD,
  PROFILE_PHOTO_MATCH_HAMMING,

  // Tests
  _resetForTests
}
