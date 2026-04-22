const { normalizeHeavy, sha256 } = require('./spam-signatures')
const { hasTextualContent } = require('./text-utils')
const { spam: spamLog } = require('./logger')
const { getAccountAgeParadox } = require('./account-age')
const { getLengthStdDev, getReplyRatio, getHourZeroCount, getTopLanguage, detectLanguage } = require('./user-stats')

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
 *
 * Stored as a 16-char hex prefix (64-bit) — collision probability at 1M
 * messages per user is negligible (~5.4e-13) and saves ~48 bytes per
 * sample vs. the full 64-char sha256, or ~2.4 GB across a 1M-user DB.
 * Reader (getContentHash's consumers) works on the raw string value so
 * older 64-char entries already in production remain valid — they'll be
 * naturally replaced as the rolling window turns over.
 */
const HASH_PREFIX_LEN = 16
const getContentHash = (text) => {
  if (!text) return null
  if (!hasTextualContent(text)) return null
  const normalized = normalizeHeavy(text)
  if (!normalized || normalized.length < 5) return null
  return sha256(normalized).slice(0, HASH_PREFIX_LEN)
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
    // C1 (review): when this message is non-textual (emoji-only, sticker, …)
    // we must NOT recompute or write the ratio. The previous code divided
    // (uniqueMessageHashes || 0) / trackedMessages which yields 0 for any
    // legacy user (uniqueMessageHashes was undefined), wrongly reporting
    // a 0% uniqueness on what is actually an unmeasured message. We just
    // return the existing value untouched (default 1 if never tracked).
    const ratio = Number.isFinite(stats.uniquenessRatio) ? stats.uniquenessRatio : 1
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

  // Mongoose doesn't always notice mutations on nested-object array paths
  // (especially the first time the field is created). Mark explicitly.
  if (typeof userInfo.markModified === 'function') {
    userInfo.markModified('globalStats.uniquenessSamples')
    userInfo.markModified('globalStats.uniquenessRatio')
  }

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

  // Make Mongoose persist the subdocument array changes.
  if (typeof userInfo.markModified === 'function') {
    if (nameChanged) userInfo.markModified('nameHistory')
    if (usernameChanged) userInfo.markModified('usernameHistory')
  }

  return { nameChanged, usernameChanged }
}

// --------------------------------------------------------------------------
// Derived signals
// --------------------------------------------------------------------------

/**
 * Count identity-change events inside the last NAME_CHURN_WINDOW_MS.
 *
 * The very first entry seeded for a user is NOT a change — it is just our
 * baseline observation of their current identity. So a history of length 1
 * always reports 0 churn, even if seeded today. Only when at least 2
 * entries exist (an actual transition happened) do we count entries within
 * the window.
 */
const countRecentChanges = (history) => {
  if (!Array.isArray(history) || history.length < 2) return 0
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

  // Account-age paradox — purely structural, no lists. Arithmetic on the
  // account-id-predicted creation date vs. our locally observed firstSeen.
  const paradox = (from?.id && stats.firstSeen)
    ? getAccountAgeParadox(from.id, stats.firstSeen)
    : null

  // Derived behavioural stats from the Welford running-mean / histogram /
  // language / reply tracking layer. All O(1) reads, no allocations.
  const replyRatio = getReplyRatio(userInfo)
  const lengthStdDev = getLengthStdDev(userInfo)
  const hourZeros = getHourZeroCount(userInfo)
  const topLang = getTopLanguage(userInfo)
  const avgLen = userInfo?.globalStats?.messageStats?.avgLength || 0

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
    cas: cas ? { banned: Boolean(cas.banned) } : null,
    accountAge: paradox ? {
      predictedDays: Math.round(paradox.predictedAgeDays),
      localDays: Math.round(paradox.localAgeDays),
      sleeperDays: Math.round(paradox.sleeperDays),
      isSleeperAwakened: paradox.isSleeperAwakened,
      isFreshBake: paradox.isFreshBake
    } : null,
    // Behavioural accumulators (nullable when user is too new to be meaningful)
    replyRatio,
    avgMessageLength: Math.round(avgLen),
    lengthStdDev: Math.round(lengthStdDev),
    hourZeroCount: hourZeros,
    topLanguage: topLang,
    uiLanguage: userInfo?.languageCode || from?.language_code || null
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

  // I2 (review): tightened. Both isNewAccount AND totalMessages < 20 required —
  // lols.bot has known FPs on rehabilitated/compromised accounts; a long-time
  // lurker with high spam_factor should not auto-ban without local evidence.
  const lols = userSignals?.lols
  if (lols && lols.spamFactor >= 0.8 && userContext?.isNewAccount && userSignals.totalMessages < 20) {
    return { decision: 'spam', rule: RULE_SPAM_LOLS_HIGH_FACTOR.name, confidence: RULE_SPAM_LOLS_HIGH_FACTOR.confidence, reason: RULE_SPAM_LOLS_HIGH_FACTOR.reason }
  }
  if (lols && lols.banned && userContext?.isNewAccount && userSignals.totalMessages < 20) {
    return { decision: 'spam', rule: RULE_SPAM_LOLS_BANNED_NEW.name, confidence: RULE_SPAM_LOLS_BANNED_NEW.confidence, reason: RULE_SPAM_LOLS_BANNED_NEW.reason }
  }

  // I1 (review): mass-blast — added groupsActive >= 3 to exclude single-group
  // power users (FAQ bots, support staff) who legitimately repeat answers.
  // Real blasters spread across many groups; intra-group repeaters do not.
  if (
    userSignals.trackedMessages >= UNIQUENESS_MIN_SAMPLES &&
    userSignals.uniquenessRatio <= 0.12 &&
    userSignals.totalMessages >= 50 &&
    userSignals.groupsActive >= 3 &&
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
  // I3 (review): "sleeper" name was misleading — the detector fires on first
  // observation, not on a true wake-up from idle. Added an extra requirement:
  // the user must have given us at least one earlier observation (>= 1 prior
  // message tracked) before a "wake-up + promo" verdict. Otherwise this is
  // simply a lurker's first message and we shouldn't auto-ban.
  if (
    signals.includes('sleeper_account') &&
    userSignals.totalMessages >= 2 &&
    (hasPromoSignal || signals.includes('private_invite_link') || signals.includes('url_shortener'))
  ) {
    return { decision: 'spam', rule: 'sleeper_with_promo', confidence: 90, reason: 'Old account with low history, suddenly posting promotional content' }
  }
  // homoglyph name + new account + promo signal — fake-identity scammer profile.
  if (
    signals.includes('name_homoglyph') &&
    userContext?.isNewAccount &&
    hasPromoSignal
  ) {
    return { decision: 'spam', rule: 'fake_identity_promo', confidence: 90, reason: 'Homoglyph identity with promotional content' }
  }

  // C3 (review): compromised-account rule was firing on benign single
  // username changes plus any link. Real takeovers almost always involve
  // multiple identity changes (attacker iterates) AND high-risk content
  // signals, not just any text URL. Tightened all three: require >=2
  // distinct churn events, require either high-risk signal or a strong
  // promo signal (private invite / shortener / bot deeplink), and lower
  // confidence to 80 so it goes through the warn-and-restrict tier (votable).
  const totalChurn = (userSignals.nameChurn24h || 0) + (userSignals.usernameChurn24h || 0)
  const strongPromo = signals.includes('private_invite_link') ||
    signals.includes('url_shortener') ||
    signals.includes('bot_deeplink') ||
    signals.includes('many_url_buttons')
  if (
    !userContext?.isNewAccount &&
    userSignals.totalMessages >= 30 &&
    userSignals.spamDetections === 0 &&
    totalChurn >= 2 &&
    (hasHighRiskSignal || strongPromo)
  ) {
    return { decision: 'spam', rule: 'compromised_account_rebrand', confidence: 80, reason: 'Established account with multiple recent identity changes and promotional content (likely compromised)' }
  }

  // Sleeper-awakened rule: predicted-creation date is >1 year older than
  // our local firstSeen AND the account's local activity is very new AND
  // a strong promo signal is present. This catches stolen / bought-and-
  // weaponised accounts without relying on lols.bot or keyword lists.
  const age = userSignals.accountAge
  if (
    age && age.isSleeperAwakened &&
    userSignals.totalMessages <= 5 &&
    (hasHighRiskSignal || strongPromo || hasPromoSignal)
  ) {
    return {
      decision: 'spam',
      rule: 'sleeper_awakened_promo',
      confidence: 90,
      reason: `Veteran account (~${age.predictedDays}d old) only active locally ${age.localDays}d, posting promotional content`
    }
  }

  // Chat-burst coordinated attack rule. Fires when the current user is
  // part of a cluster of 3+ new-user first-messages inside the chat with
  // structurally-similar content in <= 15min, AND the current message
  // carries any promo signal. This is the textbook coordinated-account
  // attack — avoids FP on isolated new users.
  if (
    signals.includes('chat_new_user_burst') &&
    (hasHighRiskSignal || strongPromo || hasPromoSignal)
  ) {
    return {
      decision: 'spam',
      rule: 'chat_burst_coordinated',
      confidence: 92,
      reason: 'Multiple new accounts first-posted in this chat within 15 minutes with similar content'
    }
  }

  // Custom-emoji network rule. Firing alone is not enough (benign
  // popular-pack sharing exists); combined with a strong promo signal
  // and a new-to-us user, it's a near-certainty of a coordinated emoji-
  // pack-branded spam ring.
  if (
    signals.includes('custom_emoji_cluster') &&
    userSignals.totalMessages <= 5 &&
    (hasHighRiskSignal || strongPromo)
  ) {
    return {
      decision: 'spam',
      rule: 'custom_emoji_network_promo',
      confidence: 88,
      reason: 'New user shares custom emoji IDs with a cluster of suspicious accounts'
    }
  }

  // Media fingerprint soft rule: if a media file was already seen across
  // multiple chats/users and the sender is new to us with no trust signals,
  // treat it as spam. The strong rule (velocity exceeded) fires earlier
  // in the phase chain; this is for the "almost there" case.
  if (
    signals.includes('media_multi_chat_reuse') &&
    userSignals.totalMessages <= 3 &&
    !trustSignals.includes('is_reply')
  ) {
    return {
      decision: 'spam',
      rule: 'media_multi_chat_reuse_new_user',
      confidence: 85,
      reason: 'New user sending media already posted by other accounts across chats'
    }
  }

  // Fast-post-after-join + promo. We observed the chat_member join event,
  // the user started posting within 30s, AND the message carries a promo
  // signal. Human users almost never meet both conditions at once.
  // FP guard: require NOT already-trusted (reputation > 60) to avoid
  // accidentally catching eager long-time members.
  if (
    signals.includes('fast_post_after_join') &&
    (hasPromoSignal || hasHighRiskSignal || strongPromo) &&
    (userSignals.reputation?.score || 0) < 60
  ) {
    return {
      decision: 'spam',
      rule: 'fast_post_after_join_promo',
      confidence: 88,
      reason: 'First message posted within 30 seconds of joining the chat with promotional content'
    }
  }

  // Edit-to-inject: an edited message added URL / mention / private-invite /
  // invisible chars that weren't in the original. Structurally zero-FP —
  // legitimate edits add/fix words, not promotional payloads.
  // Exempt already-trusted users (score >= 70) so a trusted admin who edits
  // their own post to add a helpful link doesn't get flagged.
  if (
    signals.includes('edit_injected_promo') &&
    (userSignals.reputation?.score || 0) < 70
  ) {
    return {
      decision: 'spam',
      rule: 'edit_injected_promo',
      confidence: 92,
      reason: 'Message was edited to insert a URL / mention / private-invite / hidden character'
    }
  }

  // Style-shift rule — compromised-account tell.
  // An established account with a long running-mean of short replies (avg
  // length < 40) suddenly posts a long message (>= mean + 3*stddev, AND at
  // least 200 chars absolute) carrying a promo signal. Real users drift
  // their style gradually; stolen-account campaigns flip abruptly.
  const currentLen = (text || '').length
  if (
    userSignals.totalMessages >= 50 &&
    userSignals.avgMessageLength > 0 && userSignals.avgMessageLength < 40 &&
    userSignals.lengthStdDev > 0 &&
    currentLen >= Math.max(200, userSignals.avgMessageLength + 3 * userSignals.lengthStdDev) &&
    (hasPromoSignal || hasHighRiskSignal)
  ) {
    return {
      decision: 'spam',
      rule: 'style_shift_promo_burst',
      confidence: 82,
      reason: `Established short-message user (avg ${userSignals.avgMessageLength} chars) suddenly posted ${currentLen}-char promo`
    }
  }

  // Language-mismatch rule (user-baseline) — coordinated-campaign signal.
  // If the user has a stable detected top language with decent history
  // (>= 15 tracked messages) and the CURRENT message is a different
  // language (structurally determined via languagedetect), combined with
  // promo signals, this is a strong fingerprint of a rented account posting
  // campaign text in a language they don't normally write.
  const currentLang = detectLanguage(text || '')
  if (
    userSignals.topLanguage &&
    userSignals.totalMessages >= 15 &&
    (hasPromoSignal || hasHighRiskSignal) &&
    currentLang && currentLang !== userSignals.topLanguage
  ) {
    return {
      decision: 'spam',
      rule: 'language_mismatch_promo',
      confidence: 80,
      reason: `User typically writes in ${userSignals.topLanguage}, current message is ${currentLang} with promo content`
    }
  }

  // Language-mismatch rule (chat-baseline).
  // Separate from the user-baseline rule: a brand-new user posting in a
  // language different from the chat's dominant one + promo = classic drop
  // of campaign content into a foreign-language chat (e.g. Uzbek spam in
  // a Ukrainian chat). We require the chat to have >= 10 language samples
  // before trusting this signal (enforced upstream in buildUserContext).
  const chatTopLang = userContext?.chatTopLanguage
  if (
    chatTopLang && currentLang && currentLang !== chatTopLang &&
    userSignals.totalMessages <= 5 &&
    (hasPromoSignal || hasHighRiskSignal || strongPromo)
  ) {
    return {
      decision: 'spam',
      rule: 'language_mismatch_chat',
      confidence: 82,
      reason: `New user posting in ${currentLang} in a chat whose dominant language is ${chatTopLang}, with promo content`
    }
  }

  // Dormancy+burst rule — stolen/dormant account awoken for campaign.
  // Account's hour-histogram shows many zero-hours (i.e. the user sleeps
  // at predictable hours) but the CURRENT message is being sent during one
  // of their usual sleep hours PLUS carrying a promo signal. Humans rarely
  // post mid-sleep; bot controllers do.
  //
  // We read the histogram via userContext.hourHistogram (populated upstream
  // by buildUserContext from the session user doc) to avoid taking the
  // whole user object as input and keep this function a pure signal layer.
  const hist = userContext?.hourHistogram
  if (
    Array.isArray(hist) && hist.length === 24 &&
    userSignals.totalMessages >= 50 &&
    (userSignals.hourZeroCount || 0) >= 6 &&
    (hasPromoSignal || hasHighRiskSignal)
  ) {
    const msgDate = userContext?.messageDate
    const nowHour = (typeof msgDate === 'number' ? new Date(msgDate * 1000) : new Date()).getUTCHours()
    if (hist[nowHour] <= 1) {
      return {
        decision: 'spam',
        rule: 'dormancy_burst_off_hour',
        confidence: 80,
        reason: `Message at UTC hour ${nowHour} is outside user's normal activity window`
      }
    }
  }

  // ===== CLEAN rules =====

  // C4 (review): trusted-bypass must NOT short-circuit a message that
  // already shows promotional intent. A compromised trusted account would
  // otherwise post a `text_url` + `cashtag` and get a 98%-clean verdict
  // skipping every downstream check. Promo-bearing messages from trusted
  // users still go through the full pipeline.
  const rep = userSignals.reputation
  if (rep?.status === 'trusted' && !hasHighRiskSignal && !hasPromoSignal && qa.risk !== 'high') {
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
