const { predictCreationDate } = require('./account-age')

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
 */
const calculateReputationScore = (globalStats, accountAge) => {
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

  // === RECOVERY FACTORS ===

  // Manual unbans (admin corrected false positive): +10 each
  const manualUnbans = Math.max(0, globalStats.manualUnbans || 0)
  score += manualUnbans * 10

  // Bound to 0-100
  return Math.max(0, Math.min(100, score))
}

/**
 * Minimum requirements to achieve trusted status
 * Prevents gaming the system by just joining groups without activity
 */
const TRUSTED_REQUIREMENTS = {
  minMessages: 50,      // Must have sent at least 50 messages
  minCleanChecks: 5,    // Must have passed at least 5 spam checks
  minGroups: 2,         // Must be active in at least 2 groups
  minScore: 75          // Must have score >= 75
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
 */
const calculateReputation = (globalStats, userId) => {
  const stats = globalStats || {}
  const accountAgeMonths = getAccountAgeMonths(userId)
  const score = calculateReputationScore(stats, accountAgeMonths)
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

  // Force reputation recalculation
  if (userInfo.reputation) {
    userInfo.reputation.lastCalculated = null
  }

  // Recalculate reputation
  userInfo.reputation = calculateReputation(stats, userId)

  // Apply global ban for high-confidence spam
  let globalBanApplied = false
  if (muteSuccess && confidence >= 85 && globalBanEnabled) {
    userInfo.isGlobalBanned = true
    userInfo.globalBanReason = reason
    userInfo.globalBanDate = new Date()
    globalBanApplied = true
  }

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
