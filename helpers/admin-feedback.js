/**
 * Admin-feedback loop.
 *
 * Every auto-action (mute/ban/delete) the spam pipeline takes carries a
 * `source` string (e.g. `deterministic:sleeper_awakened_promo`, `qdrant_db`,
 * `openrouter_llm`, `contact_spam:contact_foreign_script_suspicious`). When
 * an admin presses the "Not spam / restore user" button, we know that
 * particular decision was a false positive. Accumulating these per source
 * gives us precision/recall telemetry WITHOUT having to label corpora
 * manually.
 *
 * This module:
 *   1. Records the source of every recent auto-action, keyed by
 *      (chatId, userId), short TTL.
 *   2. Exposes queryLastAction() for the admin-override handler to look
 *      up what rule fired.
 *   3. Maintains a rolling per-source counter of admin-verified false
 *      positives. An hourly digest log surfaces the top-5 "most-overridden"
 *      sources.
 *   4. Optionally, when a source accumulates N+ FPs within a window,
 *      raises a loud warning so operators can tune it manually.
 *
 * All state is in-memory. Crash loses telemetry but not correctness —
 * the counters are observability, not policy.
 */

const { LRUCache } = require('lru-cache')

const { spam: spamLog } = require('./logger')
const { safeInterval } = require('./timers')

const RECENT_TTL_MS = 30 * 60 * 1000 // 30 min
const RECENT_MAX = 5000
const FP_WINDOW_MS = 24 * 60 * 60 * 1000
const FP_WARN_THRESHOLD = 10

// Recent auto-actions — lru-cache handles TTL + LRU eviction.
// value: { source, rule, confidence, reason }
const recentActions = new LRUCache({ max: RECENT_MAX, ttl: RECENT_TTL_MS, ttlAutopurge: false })

// Per-source history stream — kept as an append-only array trimmed to
// FP_WINDOW_MS. A ring buffer style structure isn't worth the indirection
// at our volumes (≤ few hundred overrides per day).
const fpHistory = []

const keyFor = (chatId, userId) => `${chatId}:${userId}`

const pruneFpHistory = (now = Date.now()) => {
  while (fpHistory.length && now - fpHistory[0].ts > FP_WINDOW_MS) fpHistory.shift()
}

/**
 * Record an auto-action fresh off the pipeline. Called from middleware
 * right before mute/ban/delete to remember "we acted on this user in
 * this chat because of this rule".
 */
const recordAction = (chatId, userId, { source, rule, confidence, reason }) => {
  if (!chatId || !userId) return
  recentActions.set(keyFor(chatId, userId), {
    source: source || 'unknown',
    rule: rule || null,
    confidence: Number(confidence) || null,
    reason: reason || null
  })
}

/**
 * Look up the last auto-action for a user in a chat. Used by the admin-
 * override handler to know "which source am I overriding?".
 */
const queryLastAction = (chatId, userId) => recentActions.get(keyFor(chatId, userId)) || null

/**
 * Register an admin override. Call this from handleAdminOverride on the
 * "Not Spam" button. Increments the FP counter for the original source
 * and emits a warning when a source accumulates too many overrides in
 * a short window.
 */
const registerOverride = (chatId, userId) => {
  const action = queryLastAction(chatId, userId)
  if (!action) return null

  const sourceKey = action.rule ? `${action.source}::${action.rule}` : action.source
  const now = Date.now()
  fpHistory.push({ sourceKey, ts: now, chatId, userId })
  pruneFpHistory(now)

  const count = fpHistory.reduce((n, h) => n + (h.sourceKey === sourceKey ? 1 : 0), 0)
  if (count >= FP_WARN_THRESHOLD) {
    spamLog.warn({ sourceKey, count, windowMs: FP_WINDOW_MS }, 'Admin-override rate high for this source')
  } else {
    spamLog.info({ sourceKey, count, chatId, userId }, 'Admin override recorded')
  }
  return { sourceKey, count }
}

/**
 * One-shot digest: top-N most-overridden sources in the current window.
 * Caller can schedule this periodically and feed it into the log stream.
 */
const digest = (topN = 5) => {
  pruneFpHistory()
  const counts = new Map()
  for (const h of fpHistory) counts.set(h.sourceKey, (counts.get(h.sourceKey) || 0) + 1)
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([sourceKey, count]) => ({ sourceKey, count }))
}

if (typeof setInterval === 'function') {
  // Hourly digest to stdout (via our logger). Top-5 most-overridden
  // sources in the last 24h. Zero-result window produces no output.
  safeInterval(() => {
    const top = digest(5)
    if (top.length > 0) {
      spamLog.info({ top }, 'spam.admin_feedback.digest')
    }
  }, 60 * 60 * 1000, { log: spamLog, label: 'admin-feedback-digest' })
}

const _resetForTests = () => {
  recentActions.clear()
  fpHistory.length = 0
}

module.exports = {
  recordAction,
  queryLastAction,
  registerOverride,
  digest,
  RECENT_TTL_MS,
  FP_WINDOW_MS,
  FP_WARN_THRESHOLD,
  _resetForTests
}
