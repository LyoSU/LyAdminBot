/**
 * In-memory LLM verdict cache keyed by normalized simHash.
 *
 * Rationale:
 *   During a spam wave, the SAME promo text is re-sent from dozens of
 *   different accounts. Each message currently triggers an independent LLM
 *   call even though the text has already been classified seconds ago.
 *   This cache dedups those calls for a short TTL.
 *
 * Design:
 *   - Key: the normalized content simHash (same function velocity.js uses).
 *     Hash collisions are rare and the cost of a wrong hit is a single
 *     mis-verdict (bounded by downstream vote/reputation layers).
 *   - Value: { verdict, ts, hits } where verdict is the full LLM result.
 *   - TTL: 6 hours — enough to cover an active wave, short enough that
 *     campaign-end FPs don't stick around.
 *   - Capacity: 5k entries, LRU eviction on insert overflow.
 *
 * We deliberately skip caching very-short messages (< 16 chars after
 * normalization) because their simHash is unstable and false hits hurt.
 *
 * Cache IS split by a small context bucket so that "new user with link"
 * and "established user with same link" don't collide — the LLM verdict
 * legitimately differs between them. The bucket is derived from a small
 * set of boolean-ish axes (isNewAccount, hasHighRisk) so it stays tiny.
 */

const { getSimHash } = require('./velocity')
const { hasTextualContent, stripEmoji } = require('./text-utils')

const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h
const CACHE_MAX_ENTRIES = 5000
const MIN_TEXT_LEN_FOR_CACHE = 16

// Map<cacheKey, { verdict, ts, hits }>
const cache = new Map()

const makeBucket = ({ isNewAccount, isHighRisk }) => {
  // Bucket is just 2 bits today. Kept as a short string so it's
  // trivially groupable in logs.
  return `${isNewAccount ? 'N' : 'E'}${isHighRisk ? 'H' : 'L'}`
}

const cacheKey = (text, bucket) => {
  if (!text || !hasTextualContent(text)) return null
  const norm = stripEmoji(text).trim().toLowerCase()
  if (norm.length < MIN_TEXT_LEN_FOR_CACHE) return null
  const sim = getSimHash(norm)
  // Defensive: `0000000000000000` is the degenerate output when tokenize
  // produced zero tokens (very short / punctuation-only / prior ASCII-only
  // bug). Treat it as an un-cacheable fingerprint so a single stale verdict
  // can't poison every future lookup.
  if (!sim || /^0+$/.test(sim)) return null
  return `${bucket}|${sim}`
}

const prune = (now) => {
  // Oldest-first eviction
  for (const [key, entry] of cache) {
    if (now - entry.ts > CACHE_TTL_MS) cache.delete(key)
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const first = cache.keys().next().value
    if (!first) break
    cache.delete(first)
  }
}

/**
 * Look up a verdict. Returns null on miss, or the stored verdict with
 * hits counter incremented on hit.
 */
const get = (text, bucketCtx) => {
  const key = cacheKey(text, makeBucket(bucketCtx || {}))
  if (!key) return null
  const entry = cache.get(key)
  if (!entry) return null
  const now = Date.now()
  if (now - entry.ts > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  entry.hits = (entry.hits || 0) + 1
  return { ...entry.verdict, cacheHits: entry.hits, cacheAgeMs: now - entry.ts }
}

/**
 * Store a verdict under the current text's simHash. Safe to call with any
 * verdict (spam or clean) — we cache both because the savings come from
 * avoiding the LLM call, not from picking sides.
 */
const set = (text, bucketCtx, verdict) => {
  const key = cacheKey(text, makeBucket(bucketCtx || {}))
  if (!key || !verdict) return false
  const now = Date.now()
  cache.set(key, { verdict, ts: now, hits: 0 })
  prune(now)
  return true
}

const size = () => cache.size
const _resetForTests = () => cache.clear()

module.exports = {
  get,
  set,
  size,
  cacheKey,
  makeBucket,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  _resetForTests
}
