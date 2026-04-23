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
 *   - Value: { verdict, insertedAt, hits }
 *   - TTL: 6 hours — enough to cover an active wave, short enough that
 *     campaign-end FPs don't stick around.
 *   - Capacity: 5k entries, LRU eviction handled by `lru-cache`.
 *
 * We deliberately skip caching very-short messages (< 16 chars after
 * normalization) because their simHash is unstable and false hits hurt.
 *
 * Cache IS split by a small context bucket so that "new user with link"
 * and "established user with same link" don't collide — the LLM verdict
 * legitimately differs between them. The bucket is derived from a small
 * set of boolean-ish axes (isNewAccount, hasHighRisk) so it stays tiny.
 */

const { LRUCache } = require('lru-cache')

const { getSimHash } = require('./velocity')
const { hasTextualContent, stripEmoji } = require('./text-utils')

const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h
const CACHE_MAX_ENTRIES = 5000
const MIN_TEXT_LEN_FOR_CACHE = 16

// Only confident verdicts are worth propagating. A 20%-clean verdict is
// effectively "LLM couldn't decide, leaning safe" — if that gets cached and
// replayed for a new user 30 min later, we've handed a soft opinion the
// power of a definitive one. Below these thresholds, we re-query the LLM
// with the new user's context instead of reusing a stale soft call.
const MIN_CONFIDENCE_CLEAN_FOR_CACHE = 80  // clean = low confidence number
const MIN_CONFIDENCE_SPAM_FOR_CACHE = 85

const cache = new LRUCache({
  max: CACHE_MAX_ENTRIES,
  ttl: CACHE_TTL_MS,
  ttlAutopurge: false
})

const makeBucket = ({ isNewAccount, isHighRisk, isSleeper, hasChurn }) => {
  // 4 bits — still tiny, still groupable. Sleeper-awakened and name/username
  // churn both correlate with hijacked/rotating-identity accounts, so we
  // don't want to cross-pollinate their verdicts with fresh accounts' or
  // established users' — even when the text+risk bucket would otherwise match.
  return `${isNewAccount ? 'N' : 'E'}${isHighRisk ? 'H' : 'L'}${isSleeper ? 'S' : '_'}${hasChurn ? 'C' : '_'}`
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

/**
 * Look up a verdict. Returns null on miss, or the stored verdict with
 * hits counter incremented on hit.
 */
const get = (text, bucketCtx) => {
  const key = cacheKey(text, makeBucket(bucketCtx || {}))
  if (!key) return null
  const entry = cache.get(key)
  if (!entry) return null
  entry.hits = (entry.hits || 0) + 1
  return {
    ...entry.verdict,
    cacheHits: entry.hits,
    cacheAgeMs: Date.now() - entry.insertedAt
  }
}

// Only confident verdicts replay well across users. A low-confidence clean
// (LLM "leaning safe, not sure") shouldn't be replayed at face value for
// the next account that sends a similar message — that account's context
// (sleeper, churn, new) deserves its own LLM look.
const isConfidentEnoughToCache = (verdict) => {
  if (!verdict || typeof verdict.confidence !== 'number') return false
  if (verdict.isSpam) return verdict.confidence >= MIN_CONFIDENCE_SPAM_FOR_CACHE
  // For clean verdicts: "confidence" in this codebase is the *spam score*,
  // so a high number means "very confident this IS spam". Clean verdicts
  // come in with low numbers. Confident clean = low number (≤20% spam ≈
  // ≥80% clean).
  return verdict.confidence <= (100 - MIN_CONFIDENCE_CLEAN_FOR_CACHE)
}

/**
 * Store a verdict under the current text's simHash. Only confident verdicts
 * are cached — see isConfidentEnoughToCache. Soft calls re-query the LLM
 * for the next user so their context is evaluated fresh.
 */
const set = (text, bucketCtx, verdict) => {
  const key = cacheKey(text, makeBucket(bucketCtx || {}))
  if (!key || !verdict) return false
  if (!isConfidentEnoughToCache(verdict)) return false
  cache.set(key, { verdict, insertedAt: Date.now(), hits: 0 })
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
  isConfidentEnoughToCache,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  MIN_CONFIDENCE_CLEAN_FOR_CACHE,
  MIN_CONFIDENCE_SPAM_FOR_CACHE,
  _resetForTests
}
