const { normalizeHeavy, sha256 } = require('./spam-signatures')
const { hasTextualContent } = require('./text-utils')
const { spam: spamLog } = require('./logger')

/**
 * Unified signal layer for the antispam pipeline.
 *
 * Responsibilities:
 *   1. Track per-user signal state (uniqueness of text, name/username churn).
 *   2. Derive composite signals (uniquenessRatio, nameChurn24h, lolsVerdict).
 *   3. Run a deterministic verdict — conservative rules that allow the pipeline
 *      to decide SPAM or CLEAN without an LLM call when the evidence is strong.
 *   4. Produce structured log payloads so every decision is diagnosable from
 *      logs alone (user can paste logs and we can reason about them).
 *
 * Design goals:
 *   - Zero false positives on deterministic verdicts. Thresholds are deliberately
 *     high; if in doubt, fall through to the LLM phase.
 *   - O(1) per-user memory: we keep only the last 50 normalized hashes + 10 names.
 *   - Cheap to compute: pure functions over the user document + context.
 */

const UNIQUENESS_WINDOW_SIZE = 50
const UNIQUENESS_MIN_SAMPLES = 30 // need at least this many before ratio is trusted
const NAME_HISTORY_LIMIT = 10
const USERNAME_HISTORY_LIMIT = 10
const NAME_CHURN_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 h

// --------------------------------------------------------------------------
// Uniqueness tracker
// --------------------------------------------------------------------------

/**
 * Compute a normalization-aware content hash for a user-sent message.
 * Returns null for empty or non-textual messages (emoji-only, stickers, …).
 */
const getContentHash = (text) => {
  if (!text) return null
  if (!hasTextualContent(text)) return null
  const normalized = normalizeHeavy(text)
  if (!normalized || normalized.length < 5) return null
  return sha256(normalized)
}

/**
 * Update user.globalStats uniqueness fields in-place.
 * Uses a rolling window of the last UNIQUENESS_WINDOW_SIZE hashes.
 * This is O(1) memory per user but preserves a meaningful ratio.
 *
 * @returns {{ hash: string|null, uniquenessRatio: number, trackedMessages: number }}
 */
const updateUniqueness = (userInfo, text) => {
  if (!userInfo) return { hash: null, uniquenessRatio: 1, trackedMessages: 0 }
  const stats = userInfo.globalStats || (userInfo.globalStats = {})

  if (!Array.isArray(stats.uniquenessSamples)) stats.uniquenessSamples = []
  stats.trackedMessages = stats.trackedMessages || 0

  const hash = getContentHash(text)
  if (!hash) {
    const ratio = stats.trackedMessages > 0
      ? (stats.uniqueMessageHashes || 0) / stats.trackedMessages
      : 1
    stats.uniquenessRatio = ratio
    return { hash: null, uniquenessRatio: ratio, trackedMessages: stats.trackedMessages }
  }

  stats.uniquenessSamples.push(hash)
  if (stats.uniquenessSamples.length > UNIQUENESS_WINDOW_SIZE) {
    stats.uniquenessSamples.shift()
  }
  stats.trackedMessages += 1

  // distinct count inside the rolling window — this is the metric we expose
  const distinctInWindow = new Set(stats.uniquenessSamples).size
  const windowSize = stats.uniquenessSamples.length
  const ratio = windowSize > 0 ? distinctInWindow / windowSize : 1

  stats.uniqueMessageHashes = distinctInWindow
  stats.uniquenessRatio = ratio

  return { hash, uniquenessRatio: ratio, trackedMessages: stats.trackedMessages }
}

// --------------------------------------------------------------------------
// Name / username history tracker
// --------------------------------------------------------------------------

const sameString = (a, b) => (a || '') === (b || '')

const buildDisplayName = (from) => {
  if (!from) return ''
  return [from.first_name || '', from.last_name || ''].join(' ').trim()
}

/**
 * Push a history entry if the value changed compared to the most recent entry.
 * Keeps the list capped (newest-first).
 */
const pushHistoryIfChanged = (list, value, limit) => {
  if (value === undefined || value === null) return false
  if (!Array.isArray(list)) return false
  const last = list[0]
  if (last && sameString(last.value, value)) return false
  list.unshift({ value: value || '', seenAt: new Date() })
  while (list.length > limit) list.pop()
  return true
}

/**
 * Track name / username changes on the user document. Only appends when a
 * value actually changes (first call seeds the history).
 *
 * @returns {{ nameChanged: boolean, usernameChanged: boolean }}
 */
const trackIdentity = (userInfo, from) => {
  if (!userInfo || !from) return { nameChanged: false, usernameChanged: false }
  if (!Array.isArray(userInfo.nameHistory)) userInfo.nameHistory = []
  if (!Array.isArray(userInfo.usernameHistory)) userInfo.usernameHistory = []

  const displayName = buildDisplayName(from)
  const nameChanged = pushHistoryIfChanged(userInfo.nameHistory, displayName, NAME_HISTORY_LIMIT)
  const usernameChanged = pushHistoryIfChanged(userInfo.usernameHistory, from.username || '', USERNAME_HISTORY_LIMIT)

  return { nameChanged, usernameChanged }
}

// --------------------------------------------------------------------------
// Derived signals
// --------------------------------------------------------------------------

/**
 * Count identity-change events inside the last NAME_CHURN_WINDOW_MS.
 */
const countRecentChanges = (history) => {
  if (!Array.isArray(history) || history.length === 0) return 0
  const cutoff = Date.now() - NAME_CHURN_WINDOW_MS
  let count = 0
  for (const entry of history) {
    const seenAt = entry?.seenAt ? new Date(entry.seenAt).getTime() : 0
    if (seenAt >= cutoff) count += 1
  }
  return count
}

/**
 * Build a compact, log-friendly summary of everything we know about a user.
 * This goes into both the LLM context AND structured logs, so it's the
 * single source of truth for "what the system sees right now".
 */
const buildUserSignals = (userInfo, from) => {
  const stats = (userInfo && userInfo.globalStats) || {}
  const rep = (userInfo && userInfo.reputation) || { score: 50, status: 'neutral' }

  const nameChurn24h = countRecentChanges(userInfo && userInfo.nameHistory)
  const usernameChurn24h = countRecentChanges(userInfo && userInfo.usernameHistory)
  const uniquenessRatio = Number.isFinite(stats.uniquenessRatio) ? stats.uniquenessRatio : 1
  const trackedMessages = stats.trackedMessages || 0

  const lols = (userInfo && userInfo.externalBan && userInfo.externalBan.lols) || null
  const cas = (userInfo && userInfo.externalBan && userInfo.externalBan.cas) || null

  return {
    userId: from?.id || (userInfo && userInfo.telegram_id),
    isPremium: Boolean(from?.is_premium),
    hasUsername: Boolean(from?.username),
    totalMessages: stats.totalMessages || 0,
    groupsActive: stats.groupsActive || 0,
    spamDetections: stats.spamDetections || 0,
    cleanMessages: stats.cleanMessages || 0,
    uniquenessRatio,
    trackedMessages,
    nameHistoryLen: (userInfo?.nameHistory || []).length,
    usernameHistoryLen: (userInfo?.usernameHistory || []).length,
    nameChurn24h,
    usernameChurn24h,
    reputation: { score: rep.score, status: rep.status },
    lols: lols ? {
      banned: Boolean(lols.banned),
      offenses: lols.offenses || 0,
      spamFactor: lols.spamFactor || 0,
      scammer: Boolean(lols.scammer)
    } : null,
    cas: cas ? { banned: Boolean(cas.banned) } : null
  }
}

// --------------------------------------------------------------------------
// Deterministic verdict — strong, conservative rules that bypass the LLM
// --------------------------------------------------------------------------

/**
 * Strong SPAM rules. Every rule here must have precision >> recall: we accept
 * missing spam here because the LLM/vector phases will still catch it, but we
 * MUST NOT produce false positives. If in doubt, return null and let the
 * pipeline continue.
 */
const RULE_SPAM_LOLS_HIGH_FACTOR = {
  name: 'lols_high_spam_factor',
  confidence: 95,
  reason: 'Flagged by lols.bot database with very high spam factor'
}
const RULE_SPAM_LOLS_BANNED_NEW = {
  name: 'lols_banned_new_account',
  confidence: 92,
  reason: 'Banned in lols.bot and account is new'
}
const RULE_SPAM_MASS_BLAST = {
  name: 'mass_blast_low_uniqueness',
  confidence: 90,
  reason: 'Very low text uniqueness across many messages (mass blast pattern)'
}
const RULE_SPAM_IDENTITY_CHURN = {
  name: 'identity_churn_with_links',
  confidence: 88,
  reason: 'Frequent name/username churn combined with promotional content'
}

/**
 * Strong CLEAN rules. Same philosophy: precision first. Skipping the LLM for
 * a legit user is the main lever for false-positive reduction.
 */
const RULE_CLEAN_TRUSTED = {
  name: 'trusted_reputation',
  reason: 'Trusted reputation and no suspicious signals'
}
const RULE_CLEAN_ESTABLISHED_REPLY = {
  name: 'established_reply_no_signals',
  reason: 'Established user replying in conversation, no suspicious signals'
}
const RULE_CLEAN_HIGH_UNIQUENESS = {
  name: 'high_uniqueness_established',
  reason: 'Established user with high text uniqueness (natural conversation)'
}

/**
 * Return a deterministic verdict or null.
 *
 * @param {Object} params
 * @param {Object} params.userSignals  built from buildUserSignals()
 * @param {Object} params.quickAssessment quickRiskAssessment() result
 * @param {Object} params.userContext  buildUserContext() result
 * @param {string} params.text         the message text (may be empty for media)
 * @returns {null | { decision:'spam'|'clean', rule:string, confidence:number, reason:string }}
 */
const computeDeterministicVerdict = ({ userSignals, quickAssessment, userContext, text }) => {
  const qa = quickAssessment || { risk: 'medium', signals: [], trustSignals: [] }
  const signals = qa.signals || []
  const trustSignals = qa.trustSignals || []
  const hasHighRiskSignal = qa.risk === 'high' || signals.some(s => (
    s === 'forward_hidden_user' ||
    s === 'hidden_url' ||
    s === 'hidden_preview' ||
    s === 'many_url_buttons' ||
    s === 'foreign_contact'
  ))
  const hasPromoSignal = signals.some(s => (
    s === 'cashtag' ||
    s === 'text_url' ||
    s === 'inline_url_buttons' ||
    s === 'phone_number'
  ))

  // ===== SPAM rules =====

  const lols = userSignals?.lols
  if (lols && lols.spamFactor >= 0.8 && (userContext?.isNewAccount || userSignals.totalMessages < 20)) {
    return { decision: 'spam', rule: RULE_SPAM_LOLS_HIGH_FACTOR.name, confidence: RULE_SPAM_LOLS_HIGH_FACTOR.confidence, reason: RULE_SPAM_LOLS_HIGH_FACTOR.reason }
  }
  if (lols && lols.banned && userContext?.isNewAccount) {
    return { decision: 'spam', rule: RULE_SPAM_LOLS_BANNED_NEW.name, confidence: RULE_SPAM_LOLS_BANNED_NEW.confidence, reason: RULE_SPAM_LOLS_BANNED_NEW.reason }
  }

  if (
    userSignals.trackedMessages >= UNIQUENESS_MIN_SAMPLES &&
    userSignals.uniquenessRatio <= 0.12 &&
    userSignals.totalMessages >= 50 &&
    userSignals.spamDetections === 0 &&
    hasPromoSignal
  ) {
    return { decision: 'spam', rule: RULE_SPAM_MASS_BLAST.name, confidence: RULE_SPAM_MASS_BLAST.confidence, reason: RULE_SPAM_MASS_BLAST.reason }
  }

  if (
    (userSignals.nameChurn24h >= 3 || userSignals.usernameChurn24h >= 3) &&
    userContext?.isNewAccount &&
    (hasPromoSignal || hasHighRiskSignal)
  ) {
    return { decision: 'spam', rule: RULE_SPAM_IDENTITY_CHURN.name, confidence: RULE_SPAM_IDENTITY_CHURN.confidence, reason: RULE_SPAM_IDENTITY_CHURN.reason }
  }

  // Profile-signals based rules (high precision combinations).
  // private_invite_link from a new/low-history account is ~95% spam.
  if (
    signals.includes('private_invite_link') &&
    (userContext?.isNewAccount || userSignals.totalMessages < 10) &&
    userSignals.spamDetections === 0
  ) {
    return { decision: 'spam', rule: 'new_user_private_invite', confidence: 92, reason: 'Private invite link from a new/low-history account' }
  }
  // sleeper account (old ID, first message ever) + promotional signal — classic raid pattern.
  if (
    signals.includes('sleeper_account') &&
    (hasPromoSignal || signals.includes('private_invite_link') || signals.includes('url_shortener'))
  ) {
    return { decision: 'spam', rule: 'sleeper_with_promo', confidence: 90, reason: 'Sleeper account waking up with promotional content' }
  }
  // homoglyph name + new account + promo signal — fake-identity scammer profile.
  if (
    signals.includes('name_homoglyph') &&
    userContext?.isNewAccount &&
    hasPromoSignal
  ) {
    return { decision: 'spam', rule: 'fake_identity_promo', confidence: 90, reason: 'Homoglyph identity with promotional content' }
  }

  // Compromised / stolen account pattern: established account (old, established
  // history) but identity changed in the last 24h AND posting promo content now.
  // The recent rename is the takeover signal — real users almost never rebrand
  // simultaneously with starting promotional posting.
  if (
    !userContext?.isNewAccount &&
    userSignals.totalMessages >= 30 &&
    userSignals.spamDetections === 0 &&
    (userSignals.nameChurn24h >= 1 || userSignals.usernameChurn24h >= 1) &&
    (hasPromoSignal || signals.includes('private_invite_link') || signals.includes('url_shortener'))
  ) {
    return { decision: 'spam', rule: 'compromised_account_rebrand', confidence: 88, reason: 'Established account renamed and started promotional posting (likely compromised)' }
  }

  // ===== CLEAN rules =====

  const rep = userSignals.reputation
  if (rep?.status === 'trusted' && !hasHighRiskSignal && qa.risk !== 'high') {
    return { decision: 'clean', rule: RULE_CLEAN_TRUSTED.name, confidence: 98, reason: RULE_CLEAN_TRUSTED.reason }
  }

  if (
    userContext?.messageCount >= 20 &&
    userSignals.totalMessages >= 50 &&
    userContext?.isReply &&
    !hasHighRiskSignal &&
    trustSignals.includes('recent_reply') &&
    rep?.score >= 60 &&
    !hasPromoSignal
  ) {
    return { decision: 'clean', rule: RULE_CLEAN_ESTABLISHED_REPLY.name, confidence: 95, reason: RULE_CLEAN_ESTABLISHED_REPLY.reason }
  }

  if (
    userSignals.trackedMessages >= UNIQUENESS_MIN_SAMPLES &&
    userSignals.uniquenessRatio >= 0.85 &&
    userSignals.totalMessages >= 30 &&
    userSignals.groupsActive <= 5 &&
    !hasHighRiskSignal &&
    !hasPromoSignal &&
    rep?.score >= 55
  ) {
    return { decision: 'clean', rule: RULE_CLEAN_HIGH_UNIQUENESS.name, confidence: 92, reason: RULE_CLEAN_HIGH_UNIQUENESS.reason }
  }

  return null
}

// --------------------------------------------------------------------------
// Structured decision logging
// --------------------------------------------------------------------------

/**
 * Emit one diagnostic line per decision point. Shape is deliberately stable so
 * logs can be grep'd / pasted for debugging.
 *
 * Log fields:
 *   phase      — pipeline phase (custom_rules, signatures, forward_blacklist,
 *                quick_risk, deterministic, moderation, velocity, vectors, llm, final)
 *   decision   — allow | deny | skip | flag | escalate | pass
 *   confidence — 0-100 when applicable
 *   chatId / userId / messageId — Telegram identifiers
 *   reason     — human-readable short reason
 *   signals / trustSignals — arrays from quick risk assessment
 *   userSignals — compact summary from buildUserSignals()
 */
const logSpamDecision = (payload = {}) => {
  const {
    phase,
    decision,
    confidence,
    reason,
    chatId,
    userId,
    messageId,
    signals,
    trustSignals,
    userSignals,
    extras
  } = payload

  const logObj = {
    phase: phase || 'unknown',
    decision: decision || 'pass',
    ...(Number.isFinite(confidence) ? { confidence } : {}),
    ...(chatId ? { chatId } : {}),
    ...(userId ? { userId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(reason ? { reason } : {}),
    ...(Array.isArray(signals) && signals.length ? { signals } : {}),
    ...(Array.isArray(trustSignals) && trustSignals.length ? { trustSignals } : {}),
    ...(userSignals ? { user: userSignals } : {}),
    ...(extras || {})
  }

  // One line per decision so the flow is trivially reconstructable.
  spamLog.info(logObj, 'spam.decision')
}

module.exports = {
  // Constants (exported for tests / callers who want to reuse)
  UNIQUENESS_WINDOW_SIZE,
  UNIQUENESS_MIN_SAMPLES,
  NAME_HISTORY_LIMIT,
  USERNAME_HISTORY_LIMIT,

  // Trackers
  updateUniqueness,
  trackIdentity,
  getContentHash,

  // Derived signals
  buildUserSignals,
  countRecentChanges,

  // Decisions
  computeDeterministicVerdict,

  // Logging
  logSpamDecision
}
