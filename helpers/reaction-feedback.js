/**
 * Crowd-sourced reaction-based spam feedback — expanded.
 *
 * Telegram exposes `message_reaction_updated` updates when a user adds or
 * removes a reaction to a message. Real group members are fast and
 * accurate at recognising spam: 💩 👎 🤮 from real humans arriving within
 * seconds of the spam is stronger than any offline model because those
 * humans have local context.
 *
 * This module squeezes multiple signals from the same update stream:
 *
 *   1. ESCALATION: N+ distinct users apply weighted-negative reactions
 *      within 5min → retroactively delete the message (caller decides the
 *      action — this module returns a verdict).
 *
 *   2. TRUST BOOST: N+ distinct trusted users apply positive reactions
 *      within 5min → mark the SENDER's message as "community-approved",
 *      callers can use this to bump reputation.
 *
 *   3. AMPLIFICATION RING detection: sub-second bursts of POSITIVE
 *      reactions from NEW / low-history accounts on a promo message are
 *      a classic farm-amplification pattern. We flag messages whose
 *      positive reactions all arrived <3s apart from low-tenure users.
 *
 *   4. HARASSMENT BRIGADING detection: the mirror attack — coordinated
 *      NEGATIVE reactions (👎💩🤡🤮) from low-tenure / low-reputation
 *      accounts targeting a legitimate user's message. Signal this
 *      separately so callers DO NOT escalate (deleting a harmless
 *      message just because a spam ring clowned it would be doubly bad:
 *      it harms the honest user AND rewards the harassers). When
 *      brigading is detected, we suppress negativeEscalation on the
 *      same update.
 *
 *   5. CLASSIFIER-DISAGREEMENT trace: if we previously classified a
 *      message CLEAN and it now gets escalated via reactions, we log it
 *      as "crowd overruled classifier" for later offline training.
 *
 *   6. CONTROVERSY SKIP: a message with both many positive AND many
 *      negative reactions isn't spam, it's controversial. We refuse to
 *      escalate in that case.
 *
 * Design choices:
 *   - Emoji weighting (💩🤮 weighted 1.5, 👎 1.0, 🤡🤬 0.8). The weight
 *     determines the sum that must cross the threshold, not the user
 *     count — we still require N+ DISTINCT users to avoid single-user
 *     spamming many reactions.
 *   - Threshold tracking is per-message (bucketed). No persistence.
 *   - Memory bound: TTL + hard cap.
 */

const { LRUCache } = require('lru-cache')

const WINDOW_MS = 5 * 60 * 1000 // 5 min
const TTL_MS = 30 * 60 * 1000 // keep bucket this long post-message
const MAX_BUCKETS = 50000

const NEGATIVE_USER_THRESHOLD = 3
const NEGATIVE_WEIGHT_THRESHOLD = 3 // weighted-sum equivalent of 3 👎
const NEGATIVE_TRUSTED_QUORUM = 2

const POSITIVE_USER_THRESHOLD = 3
const POSITIVE_TRUSTED_QUORUM = 2

// Amplification-ring detection: if 3+ positive reactions from low-tenure
// users land within this window starting from the FIRST reaction, the
// message looks seeded by a farm. 3 seconds is short enough that only
// coordinated automation clears the bar (humans average 1-10s gap).
const AMPLIFICATION_BURST_MS = 3000
const AMPLIFICATION_LOW_TENURE_MAX_MSGS = 10

// Harassment-brigading detection (mirror of amplification). When 3+
// NEGATIVE reactions from low-tenure / low-reputation accounts land in a
// short burst targeting one message, it's almost always a coordinated
// attack on an honest user — NOT community consensus. When this fires we
// suppress negativeEscalation on the same bucket so the bot doesn't
// unwittingly assist the harassers by deleting the victim's message.
const BRIGADING_BURST_MS = 5000
const BRIGADING_LOW_TENURE_MAX_MSGS = 20
const BRIGADING_LOW_REPUTATION_MAX = 40
const BRIGADING_MIN_SUSPICIOUS = 3

// Controversial: if both sides have >= 2 trusted users, refuse to escalate.
const CONTROVERSY_SKIP_QUORUM = 2

// Weighted emoji. Only universally-recognised reactions — no culture-
// specific tokens. Any weight >= 1.0 indicates spam-signal; 1.5 is
// strong-disgust (visceral rejection, almost never applied to clean
// content by real humans).
const NEGATIVE_WEIGHTS = new Map([
  ['💩', 1.5],
  ['🤮', 1.5],
  ['🤢', 1.5],
  ['👎', 1.0],
  ['🤡', 0.8],
  ['🤬', 0.8]
])
const POSITIVE_EMOJIS = new Set([
  '👍', '❤️', '🔥', '🎉', '🥰', '😍', '🤩', '💯', '👌', '✨'
])

// key: `chatId:messageId` → per-message aggregate state.
// lru-cache handles both the TTL (30min) and max-size eviction;
// `updateAgeOnGet:true` slides the TTL forward while a message is still
// attracting reactions, keeping hot buckets alive.
const buckets = new LRUCache({
  max: MAX_BUCKETS,
  ttl: TTL_MS,
  ttlAutopurge: false,
  updateAgeOnGet: true
})

const keyFor = (chatId, messageId) => `${chatId}:${messageId}`

const emojiWeight = (reactions) => {
  if (!Array.isArray(reactions)) return { positive: 0, negativeWeight: 0, negativeEmojis: [], positiveEmojis: [] }
  let positive = 0
  let negativeWeight = 0
  const negativeEmojis = []
  const positiveEmojis = []
  for (const r of reactions) {
    if (!r || r.type !== 'emoji') continue
    const w = NEGATIVE_WEIGHTS.get(r.emoji)
    if (w !== undefined) { negativeWeight += w; negativeEmojis.push(r.emoji); continue }
    if (POSITIVE_EMOJIS.has(r.emoji)) { positive++; positiveEmojis.push(r.emoji) }
  }
  return { positive, negativeWeight, negativeEmojis, positiveEmojis }
}

/**
 * Classify the effect of a reaction update as an ADDITION of positive or
 * negative emoji (we ignore pure removals and no-op changes).
 */
const classifyUpdate = (update) => {
  if (!update) return { addedNegative: false, addedPositive: false, negativeWeight: 0 }
  const before = emojiWeight(update.old_reaction)
  const after = emojiWeight(update.new_reaction)
  return {
    addedNegative: after.negativeWeight > before.negativeWeight,
    addedPositive: after.positive > before.positive,
    negativeWeight: Math.max(0, after.negativeWeight - before.negativeWeight),
    positiveDelta: Math.max(0, after.positive - before.positive),
    beforeNeg: before,
    afterNeg: after
  }
}

const getOrCreateBucket = (chatId, messageId, now) => {
  const k = keyFor(chatId, messageId)
  let b = buckets.get(k)
  if (!b) {
    b = {
      firstAt: now,
      lastAt: now,
      escalatedNeg: false,
      trustBoosted: false,
      negUsers: new Map(),
      posUsers: new Map(),
      amplification: null
    }
    buckets.set(k, b)
  }
  return b
}

const pruneBucket = (bucket, now) => {
  const cutoff = now - WINDOW_MS
  for (const [uid, meta] of bucket.negUsers) if (meta.reactionTs < cutoff) bucket.negUsers.delete(uid)
  for (const [uid, meta] of bucket.posUsers) if (meta.reactionTs < cutoff) bucket.posUsers.delete(uid)
}

/**
 * Record a reaction event and return a verdict package describing any
 * threshold crossings on this update. Verdict keys (all optional):
 *   - negativeEscalation: { distinctUsers, trustedUsers, weightSum, windowMs }
 *   - positiveTrustBoost: { distinctUsers, trustedUsers, windowMs }
 *   - amplificationRing:  { burstSize, burstMs }
 *   - controversySkip:    true   (when both sides are strong — we refuse
 *                                  to escalate anything this update)
 *
 * @param {Object} ctx  telegraf update context for the reaction
 * @param {Object} reactor { userId, trusted, tenureMessages }
 * @param {Object} classification result of classifyUpdate() above
 */
const recordReaction = (chatId, messageId, reactor, classification) => {
  if (!chatId || !messageId || !reactor || !reactor.userId || !classification) return null
  const now = Date.now()
  const bucket = getOrCreateBucket(chatId, messageId, now)
  pruneBucket(bucket, now)

  if (classification.addedNegative) {
    bucket.negUsers.set(reactor.userId, {
      reactionTs: now,
      weight: classification.negativeWeight,
      trusted: Boolean(reactor.trusted),
      tenure: Number.isFinite(reactor.tenureMessages) ? reactor.tenureMessages : null,
      reputationScore: Number.isFinite(reactor.reputationScore) ? reactor.reputationScore : null
    })
  }
  if (classification.addedPositive) {
    bucket.posUsers.set(reactor.userId, {
      reactionTs: now,
      trusted: Boolean(reactor.trusted),
      tenure: Number.isFinite(reactor.tenureMessages) ? reactor.tenureMessages : null,
      reputationScore: Number.isFinite(reactor.reputationScore) ? reactor.reputationScore : null
    })
  }
  bucket.lastAt = now

  // --- Controversy check ----------------------------------------------
  // If a message has STRONG positive AND strong negative consensus we
  // refuse to escalate either direction — that's a hot-take, not spam.
  const trustedPos = Array.from(bucket.posUsers.values()).filter(u => u.trusted).length
  const trustedNeg = Array.from(bucket.negUsers.values()).filter(u => u.trusted).length
  const controversy = trustedPos >= CONTROVERSY_SKIP_QUORUM && trustedNeg >= CONTROVERSY_SKIP_QUORUM

  const verdict = {}

  // --- Harassment brigading check (mirror of amplification-ring) ------
  // Done BEFORE negative escalation so we can suppress escalation in
  // cases where the negative reactions look like a coordinated attack.
  // Logic: 3+ low-tenure / low-reputation reactors hitting the message
  // with negative reactions in a <=5s window = brigading. We flag it
  // separately and refuse to escalate-delete on the same update.
  if (!bucket.amplification && classification.addedNegative) {
    const suspicious = Array.from(bucket.negUsers.values()).filter(u => {
      const lowTenure = u.tenure !== null && u.tenure <= BRIGADING_LOW_TENURE_MAX_MSGS
      const lowRep = u.reputationScore !== null && u.reputationScore <= BRIGADING_LOW_REPUTATION_MAX
      return lowTenure || lowRep
    })
    if (suspicious.length >= BRIGADING_MIN_SUSPICIOUS) {
      const times = suspicious.map(u => u.reactionTs).sort((a, b) => a - b)
      const burstMs = times[times.length - 1] - times[0]
      if (burstMs <= BRIGADING_BURST_MS) {
        bucket.brigading = { count: suspicious.length, burstMs }
        verdict.harassmentBrigading = { count: suspicious.length, burstMs }
      }
    }
  }

  // --- Negative escalation --------------------------------------------
  // Suppressed when brigading was detected on this bucket. Also skipped
  // under controversy.
  if (!bucket.escalatedNeg && !controversy && !bucket.brigading) {
    const distinctNeg = bucket.negUsers.size
    const weightSum = Array.from(bucket.negUsers.values()).reduce((acc, m) => acc + (m.weight || 0), 0)
    if (
      distinctNeg >= NEGATIVE_USER_THRESHOLD &&
      weightSum >= NEGATIVE_WEIGHT_THRESHOLD &&
      trustedNeg >= NEGATIVE_TRUSTED_QUORUM
    ) {
      bucket.escalatedNeg = true
      verdict.negativeEscalation = {
        distinctUsers: distinctNeg,
        trustedUsers: trustedNeg,
        weightSum,
        windowMs: bucket.lastAt - bucket.firstAt
      }
    }
  }

  // --- Positive trust boost -------------------------------------------
  if (!bucket.trustBoosted && !controversy) {
    const distinctPos = bucket.posUsers.size
    if (
      distinctPos >= POSITIVE_USER_THRESHOLD &&
      trustedPos >= POSITIVE_TRUSTED_QUORUM
    ) {
      bucket.trustBoosted = true
      verdict.positiveTrustBoost = {
        distinctUsers: distinctPos,
        trustedUsers: trustedPos,
        windowMs: bucket.lastAt - bucket.firstAt
      }
    }
  }

  // --- Amplification ring ---------------------------------------------
  // Check positive reactions for sub-second burst from low-tenure users.
  // This runs every time a positive reaction is added so we catch the
  // moment the ring completes.
  if (!bucket.amplification && classification.addedPositive) {
    const tenureLow = Array.from(bucket.posUsers.values())
      .filter(u => u.tenure !== null && u.tenure <= AMPLIFICATION_LOW_TENURE_MAX_MSGS)
    if (tenureLow.length >= POSITIVE_USER_THRESHOLD) {
      const times = tenureLow.map(u => u.reactionTs).sort((a, b) => a - b)
      const burstMs = times[times.length - 1] - times[0]
      if (burstMs <= AMPLIFICATION_BURST_MS) {
        bucket.amplification = { burstSize: tenureLow.length, burstMs }
        verdict.amplificationRing = { burstSize: tenureLow.length, burstMs }
      }
    }
  }

  if (controversy) verdict.controversySkip = true

  return Object.keys(verdict).length > 0 ? verdict : null
}

const queryBucket = (chatId, messageId) => {
  const b = buckets.get(keyFor(chatId, messageId))
  if (!b) return null
  return {
    negUsers: b.negUsers.size,
    posUsers: b.posUsers.size,
    escalatedNeg: b.escalatedNeg,
    trustBoosted: b.trustBoosted,
    amplification: b.amplification,
    windowMs: b.lastAt - b.firstAt
  }
}

const size = () => buckets.size
const _resetForTests = () => buckets.clear()

module.exports = {
  recordReaction,
  queryBucket,
  classifyUpdate,
  emojiWeight,
  size,
  NEGATIVE_WEIGHTS,
  POSITIVE_EMOJIS,
  NEGATIVE_USER_THRESHOLD,
  NEGATIVE_WEIGHT_THRESHOLD,
  NEGATIVE_TRUSTED_QUORUM,
  POSITIVE_USER_THRESHOLD,
  POSITIVE_TRUSTED_QUORUM,
  AMPLIFICATION_BURST_MS,
  AMPLIFICATION_LOW_TENURE_MAX_MSGS,
  WINDOW_MS,
  _resetForTests
}
