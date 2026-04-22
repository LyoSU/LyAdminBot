const { predictCreationDate } = require('./account-age')
const graphNeighbourhood = require('./graph-neighbourhood')

/**
 * Calculate account age in months from Telegram user ID
 * Returns 0 months for channels (negative IDs) or invalid IDs
 *
 * @param {number} userId - User or channel ID
 * @returns {{ months: number, isExtrapolated: boolean }}
 */
const getAccountAgeMonths = (userId) => {
  // Invalid ID or channel (negative) - return 0 months
  if (!userId || typeof userId !== 'number' || userId < 0) {
    return { months: 0, isExtrapolated: true }
  }

  const [prefix, creationDate] = predictCreationDate(userId)
  const now = new Date()
  const months = Math.max(0, (now - creationDate) / (1000 * 60 * 60 * 24 * 30))
  // '>' means extrapolated beyond known data, '?' means invalid/unknown
  const isExtrapolated = prefix === '>' || prefix === '?'
  return { months, isExtrapolated }
}

/**
 * Calculate reputation score based on global stats
 * Score range: 0-100
 * - 100 = Highly trusted (long history, many groups, no spam)
 * - 50 = Neutral (new user, no data)
 * - 0 = Known spammer
 *
 * @param {Object} globalStats
 * @param {Object|number} accountAge { months, isExtrapolated } or legacy number
 * @param {Object} extras { isGlobalBanned, uniquenessRatio, externalBan }
 */
const calculateReputationScore = (globalStats, accountAge, extras = {}) => {
  // Handle both old format (number) and new format ({ months, isExtrapolated })
  const ageMonths = typeof accountAge === 'number' ? accountAge : (accountAge?.months || 0)
  const isExtrapolated = typeof accountAge === 'object' ? accountAge.isExtrapolated : false

  let score = 50 // Start neutral

  // === POSITIVE FACTORS (max +50) ===

  // Longevity bonus: +2 per month, max +20
  // BUT: cap at +10 for extrapolated ages (uncertain data)
  const maxAgeBonus = isExtrapolated ? 10 : 20
  score += Math.min(maxAgeBonus, Math.floor(ageMonths * 2))

  // Multi-group activity: +5 per group, max +15
  const groupsActive = Math.max(0, globalStats.groupsActive || 0)
  score += Math.min(15, groupsActive * 5)

  // Message volume: +1 per 100 messages, max +10
  const totalMessages = Math.max(0, globalStats.totalMessages || 0)
  score += Math.min(10, Math.floor(totalMessages / 100))

  // Clean message ratio bonus: up to +5
  const cleanMessages = Math.max(0, globalStats.cleanMessages || 0)
  const spamDetections = Math.max(0, globalStats.spamDetections || 0)
  const totalChecked = cleanMessages + spamDetections
  if (totalChecked > 10) {
    const cleanRatio = cleanMessages / totalChecked
    score += Math.floor(cleanRatio * 5)
  }

  // High text uniqueness over a meaningful sample = natural conversation.
  // Conservative: only adds bonus, never penalises (low uniqueness alone is
  // not enough to call someone a spammer — that lives in deterministic rules).
  const uniquenessRatio = Number.isFinite(extras.uniquenessRatio) ? extras.uniquenessRatio : null
  if (uniquenessRatio !== null && totalMessages >= 30 && uniquenessRatio >= 0.7) {
    score += 5
  }

  // === NEGATIVE FACTORS (can go deeply negative) ===

  // Spam detections: -15 per detection, with decay for rehabilitated users
  const rawPenalty = spamDetections * 15
  const cleanToSpamRatio = spamDetections > 0 ? cleanMessages / spamDetections : Infinity
  let decayMultiplier = 1.0
  if (cleanToSpamRatio > 20) decayMultiplier = 0.25
  else if (cleanToSpamRatio > 10) decayMultiplier = 0.5
  else if (cleanToSpamRatio > 5) decayMultiplier = 0.75
  score -= Math.floor(rawPenalty * decayMultiplier)

  // Deleted messages: -5 per deletion
  const deletedMessages = Math.max(0, globalStats.deletedMessages || 0)
  score -= deletedMessages * 5

  // External provider signals — informative but NOT authoritative.
  // lols/CAS have wider coverage but also false positives; we treat them as
  // a soft penalty, not as a verdict. A combination with local spam history
  // is what really matters (handled in deterministic rules).
  const lols = extras.externalBan && extras.externalBan.lols
  if (lols && lols.banned) score -= 15
  if (lols && Number.isFinite(lols.spamFactor) && lols.spamFactor >= 0.6) {
    score -= Math.floor(lols.spamFactor * 10)
  }
  const cas = extras.externalBan && extras.externalBan.cas
  if (cas && cas.banned) score -= 12

  // === RECOVERY FACTORS ===

  // Manual unbans (admin corrected false positive): +10 each
  const manualUnbans = Math.max(0, globalStats.manualUnbans || 0)
  score += manualUnbans * 10

  // === HARD CEILING for currently banned accounts ===
  // If an admin/global ban is in effect, reputation must reflect that.
  // Otherwise we end up with the 13k+ globally-banned-but-score-above-20
  // mismatch we measured in production.
  if (extras.isGlobalBanned) {
    score = Math.min(score, 10)
  }

  // Bound to 0-100
  return Math.max(0, Math.min(100, score))
}

/**
 * Minimum requirements to achieve trusted status
 * Prevents gaming the system by just joining groups without activity
 */
const TRUSTED_REQUIREMENTS = {
  minMessages: 50, // Must have sent at least 50 messages
  minCleanChecks: 5, // Must have passed at least 5 spam checks
  minGroups: 2, // Must be active in at least 2 groups
  minScore: 75 // Must have score >= 75
}

/**
 * Check if user meets minimum requirements for trusted status
 */
const meetsTrustedRequirements = (globalStats) => {
  if (!globalStats) return false
  const { totalMessages = 0, cleanMessages = 0, groupsActive = 0 } = globalStats
  return (
    totalMessages >= TRUSTED_REQUIREMENTS.minMessages &&
    cleanMessages >= TRUSTED_REQUIREMENTS.minCleanChecks &&
    groupsActive >= TRUSTED_REQUIREMENTS.minGroups
  )
}

/**
 * Get reputation status from score and activity
 * - trusted (75+): Skip spam check entirely (requires minimum activity)
 * - neutral (40-74): Normal checks
 * - suspicious (20-39): Lower threshold (more aggressive)
 * - restricted (0-19): Very aggressive
 *
 * @param {number} score - Reputation score (0-100)
 * @param {Object} globalStats - Optional stats to check trusted requirements
 */
const getReputationStatus = (score, globalStats = null) => {
  // trusted requires both high score AND minimum activity
  if (score >= TRUSTED_REQUIREMENTS.minScore) {
    if (globalStats && meetsTrustedRequirements(globalStats)) {
      return 'trusted'
    }
    // High score but insufficient activity = neutral (capped)
    return 'neutral'
  }
  if (score >= 40) return 'neutral'
  if (score >= 20) return 'suspicious'
  return 'restricted'
}

/**
 * Calculate full reputation object for a user
 *
 * @param {Object} globalStats
 * @param {number} userId
 * @param {Object} extras { isGlobalBanned, externalBan, uniquenessRatio }
 */
const calculateReputation = (globalStats, userId, extras = {}) => {
  const stats = globalStats || {}
  const accountAgeMonths = getAccountAgeMonths(userId)
  const enrichedExtras = {
    ...extras,
    uniquenessRatio: Number.isFinite(extras.uniquenessRatio) ? extras.uniquenessRatio : stats.uniquenessRatio
  }
  const score = calculateReputationScore(stats, accountAgeMonths, enrichedExtras)
  return {
    score,
    status: getReputationStatus(score, stats),
    lastCalculated: new Date()
  }
}

/**
 * Update user stats and optionally set global ban after spam detection
 * Unified logic used by both spam-check middleware and report handler
 *
 * @param {Object} userInfo - User info document from session
 * @param {Object} options - Options object
 * @param {number} options.userId - User's Telegram ID
 * @param {boolean} options.messageDeleted - Whether message was deleted
 * @param {number} options.confidence - Spam confidence level (0-100)
 * @param {string} options.reason - Spam reason for global ban
 * @param {boolean} options.muteSuccess - Whether mute was successful
 * @param {boolean} options.globalBanEnabled - Whether global ban is enabled in group
 * @returns {Object} - Updated stats and whether global ban was applied
 */
const processSpamAction = (userInfo, options) => {
  const {
    userId,
    messageDeleted = false,
    confidence = 0,
    reason = 'AI-detected spam',
    muteSuccess = false,
    globalBanEnabled = true
  } = options

  if (!userInfo) {
    return { statsUpdated: false, globalBanApplied: false }
  }

  // Initialize globalStats if needed
  const stats = userInfo.globalStats || (userInfo.globalStats = {})
  stats.spamDetections = (stats.spamDetections || 0) + 1

  if (messageDeleted) {
    stats.deletedMessages = (stats.deletedMessages || 0) + 1
  }

  // Force reputation recalculation marker
  if (userInfo.reputation) {
    userInfo.reputation.lastCalculated = null
  }

  // NOTE: reputation calculation is deferred until AFTER potentially setting
  // isGlobalBanned below, so the hard ceiling (score <= 10 when banned) is
  // applied immediately on the very first detection that triggers a ban.

  // Apply global ban — three triggers:
  //   1. High-confidence single detection (existing behavior)
  //   2. Repeat-offender escalation: 5+ detections in total, regardless of
  //      per-event confidence (fixes the 24+ users in prod with 100+ detections
  //      that never got globally banned because each event was 70-84%).
  //   3. External provider already says banned (lols.bot / CAS).
  // Trigger 1 still requires muteSuccess (avoids banning when we couldn't
  // even act locally), but triggers 2/3 fire even without mute permission so
  // that downstream groups get the propagated signal.
  let globalBanApplied = false
  if (globalBanEnabled && !userInfo.isGlobalBanned) {
    const detections = stats.spamDetections || 0
    const lols = userInfo.externalBan && userInfo.externalBan.lols
    const cas = userInfo.externalBan && userInfo.externalBan.cas
    const externalBanned = (lols && lols.banned) || (cas && cas.banned)

    let banReason = null
    if (muteSuccess && confidence >= 85) {
      banReason = reason
    } else if (detections >= 5) {
      banReason = `Repeat offender (${detections} detections)`
    } else if (externalBanned) {
      banReason = lols && lols.banned ? 'lols.bot ban' : 'CAS ban'
    }

    if (banReason) {
      userInfo.isGlobalBanned = true
      userInfo.globalBanReason = banReason
      userInfo.globalBanDate = new Date()
      globalBanApplied = true

      // Register the ban in the graph-neighbourhood buffer so that the NEXT
      // incoming user who shares chats with this one can be soft-tainted
      // as "sibling of a freshly-banned farm account". No persistence —
      // the buffer is in-memory with short TTL.
      try {
        graphNeighbourhood.registerBan(userId, {
          chats: stats.groupsList || [],
          firstSeenAt: stats.firstSeen
        })
      } catch (_err) { /* non-fatal */ }
    }
  }

  // Now compute reputation with the freshly-set ban state in scope.
  userInfo.reputation = calculateReputation(stats, userId, {
    isGlobalBanned: userInfo.isGlobalBanned,
    externalBan: userInfo.externalBan
  })

  return {
    statsUpdated: true,
    globalBanApplied,
    newReputation: userInfo.reputation
  }
}

module.exports = {
  calculateReputationScore,
  getReputationStatus,
  calculateReputation,
  getAccountAgeMonths,
  processSpamAction,
  meetsTrustedRequirements,
  TRUSTED_REQUIREMENTS
}
