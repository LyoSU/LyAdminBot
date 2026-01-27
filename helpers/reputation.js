const { predictCreationDate } = require('./account-age')

/**
 * Calculate account age in months from Telegram user ID
 */
const getAccountAgeMonths = (userId) => {
  const [, creationDate] = predictCreationDate(userId)
  const now = new Date()
  return (now - creationDate) / (1000 * 60 * 60 * 24 * 30)
}

/**
 * Calculate reputation score based on global stats
 * Score range: 0-100
 * - 100 = Highly trusted (long history, many groups, no spam)
 * - 50 = Neutral (new user, no data)
 * - 0 = Known spammer
 */
const calculateReputationScore = (globalStats, accountAgeMonths) => {
  let score = 50 // Start neutral

  // === POSITIVE FACTORS (max +50) ===

  // Longevity bonus: +2 per month, max +20
  score += Math.min(20, Math.floor(accountAgeMonths * 2))

  // Multi-group activity: +5 per group, max +15
  score += Math.min(15, (globalStats.groupsActive || 0) * 5)

  // Message volume: +1 per 100 messages, max +10
  score += Math.min(10, Math.floor((globalStats.totalMessages || 0) / 100))

  // Clean message ratio bonus: up to +5
  const totalChecked = (globalStats.cleanMessages || 0) + (globalStats.spamDetections || 0)
  if (totalChecked > 10) {
    const cleanRatio = globalStats.cleanMessages / totalChecked
    score += Math.floor(cleanRatio * 5)
  }

  // === NEGATIVE FACTORS (can go deeply negative) ===

  // Spam detections: -15 per detection
  score -= (globalStats.spamDetections || 0) * 15

  // Deleted messages: -5 per deletion
  score -= (globalStats.deletedMessages || 0) * 5

  // === RECOVERY FACTORS ===

  // Manual unbans (admin corrected false positive): +10 each
  score += (globalStats.manualUnbans || 0) * 10

  // Bound to 0-100
  return Math.max(0, Math.min(100, score))
}

/**
 * Get reputation status from score
 * - trusted (75+): Skip spam check entirely
 * - neutral (40-74): Normal checks
 * - suspicious (20-39): Lower threshold (more aggressive)
 * - restricted (0-19): Very aggressive
 */
const getReputationStatus = (score) => {
  if (score >= 75) return 'trusted'
  if (score >= 40) return 'neutral'
  if (score >= 20) return 'suspicious'
  return 'restricted'
}

/**
 * Calculate full reputation object for a user
 */
const calculateReputation = (globalStats, userId) => {
  const accountAgeMonths = getAccountAgeMonths(userId)
  const score = calculateReputationScore(globalStats || {}, accountAgeMonths)
  return {
    score,
    status: getReputationStatus(score),
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
  processSpamAction
}
