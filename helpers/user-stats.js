const LanguageDetect = require('languagedetect')

const { hasTextualContent } = require('./text-utils')

/**
 * Behavioural stats aggregator for a single user across all group messages.
 *
 * Everything here is O(1) memory per user — we store running aggregates, not
 * message history. Designed to run on every incoming message (group only)
 * in user-update.js, before the spam pipeline.
 *
 * The stats this module produces are used by later detectors for:
 *   - Dormancy / burst analysis (hourHistogram)
 *   - Style-shift detection (running mean + variance via Welford)
 *   - Promo-intent heuristics (entityCounts)
 *   - Stolen-account shift (mediaCounts)
 *   - Contact-card spam (contactCount — dedicated counter because the pattern
 *     is almost exclusive to spam campaigns, see production samples with
 *     Chinese contact-card attacks from +60 / +84 numbers)
 *   - Language mismatch (detectedLanguages rolling top-N)
 *
 * All writes go through an explicit path-based markModified so Mongoose
 * persists deeply-nested numeric mutations on legacy docs that had the
 * field created on-the-fly.
 */

const DETECTED_LANGUAGES_CAP = 5
const CUSTOM_EMOJI_CAP = 20
const BIO_HISTORY_CAP = 3

// Instantiate once — the detector holds a large trigram database.
const lngDetector = new LanguageDetect('iso2')

// ---------------------------------------------------------------------------
// Internal: lazy-init messageStats substructure on legacy docs
// ---------------------------------------------------------------------------

const ensureMessageStats = (user) => {
  const stats = user.globalStats || (user.globalStats = {})
  if (!stats.messageStats) {
    stats.messageStats = {
      replyCount: 0,
      editCount: 0,
      avgLength: 0,
      lengthM2: 0,
      hourHistogram: new Array(24).fill(0),
      entityCounts: {
        url: 0,
        text_link: 0,
        mention: 0,
        text_mention: 0,
        hashtag: 0,
        cashtag: 0,
        bot_command: 0,
        phone_number: 0,
        email: 0,
        spoiler: 0,
        custom_emoji: 0
      },
      mediaCounts: {
        text: 0,
        photo: 0,
        video: 0,
        voice: 0,
        video_note: 0,
        sticker: 0,
        animation: 0,
        document: 0,
        audio: 0,
        contact: 0,
        location: 0,
        poll: 0
      },
      contactCount: 0,
      formattingDiversitySum: 0
    }
  }
  // Guard legacy docs where only some nested dicts may be missing
  const ms = stats.messageStats
  if (!Array.isArray(ms.hourHistogram) || ms.hourHistogram.length !== 24) {
    ms.hourHistogram = new Array(24).fill(0)
  }
  if (!ms.entityCounts) ms.entityCounts = {}
  if (!ms.mediaCounts) ms.mediaCounts = {}
  return ms
}

// ---------------------------------------------------------------------------
// Media type detection — canonical key for mediaCounts
// ---------------------------------------------------------------------------

/**
 * Return a single canonical media-type key for the message.
 * Order matters: specific types before generic ones (video_note before video).
 */
const getMediaType = (message) => {
  if (!message) return null
  if (message.voice) return 'voice'
  if (message.video_note) return 'video_note'
  if (message.video) return 'video'
  if (message.animation) return 'animation'
  if (message.sticker) return 'sticker'
  if (message.photo) return 'photo'
  if (message.document) return 'document'
  if (message.audio) return 'audio'
  if (message.contact) return 'contact'
  if (message.location || message.venue) return 'location'
  if (message.poll) return 'poll'
  if (message.text || message.caption) return 'text'
  return null
}

// ---------------------------------------------------------------------------
// Welford's online algorithm — numerically stable running mean + variance
// ---------------------------------------------------------------------------

/**
 * Update running mean/M2 in place. n is the count AFTER the new sample
 * (caller passes the post-increment count).
 *
 * variance = M2 / (n - 1)    (sample variance, n >= 2)
 * stdDev   = sqrt(variance)
 */
const welfordUpdate = (ms, n, newValue) => {
  const delta = newValue - ms.avgLength
  ms.avgLength += delta / n
  const delta2 = newValue - ms.avgLength
  ms.lengthM2 += delta * delta2
}

// ---------------------------------------------------------------------------
// Language detection — best-effort, returns iso2 code or null
// ---------------------------------------------------------------------------

/**
 * Detect the most likely language of a message, returning an ISO-639-1 code
 * or null when confidence is too low / the library can't map.
 *
 * We request top-3 candidates and return the first one that:
 *   (a) has a non-null ISO code (the library returns null for obscure
 *       entries like "pidgin", "hawaiian" that have no iso2 mapping), and
 *   (b) scores at least 0.15 (anything lower is noise).
 *
 * Returning the first CODED candidate instead of just the top one matters
 * for English vs. pidgin disambiguation — languagedetect frequently ranks
 * pidgin above english for short English messages.
 */
const detectLanguage = (text) => {
  if (!text || !hasTextualContent(text, 8)) return null
  try {
    const results = lngDetector.detect(text, 3)
    if (!Array.isArray(results) || !results.length) return null
    for (const [code, score] of results) {
      if (code && score >= 0.15) return code
    }
    return null
  } catch (err) {
    return null
  }
}

const recordLanguage = (user, code) => {
  if (!code) return
  if (!Array.isArray(user.detectedLanguages)) user.detectedLanguages = []
  const list = user.detectedLanguages
  const existing = list.find(e => e && e.code === code)
  if (existing) {
    existing.count = (existing.count || 0) + 1
  } else {
    list.push({ code, count: 1 })
  }
  // Keep top-N by count
  list.sort((a, b) => (b.count || 0) - (a.count || 0))
  if (list.length > DETECTED_LANGUAGES_CAP) list.length = DETECTED_LANGUAGES_CAP
  if (typeof user.markModified === 'function') user.markModified('detectedLanguages')
}

// ---------------------------------------------------------------------------
// Entity accounting — also harvests custom_emoji IDs for cross-user clustering
// ---------------------------------------------------------------------------

const TRACKED_ENTITY_TYPES = new Set([
  'url', 'text_link', 'mention', 'text_mention', 'hashtag', 'cashtag',
  'bot_command', 'phone_number', 'email', 'spoiler', 'custom_emoji'
])

const recordEntities = (ms, entities) => {
  if (!Array.isArray(entities) || entities.length === 0) return { distinctTypes: 0, customEmojiIds: [] }
  const distinctTypes = new Set()
  const customEmojiIds = []
  for (const entity of entities) {
    if (!entity || !entity.type) continue
    const type = entity.type
    distinctTypes.add(type)
    if (TRACKED_ENTITY_TYPES.has(type)) {
      ms.entityCounts[type] = (ms.entityCounts[type] || 0) + 1
      if (type === 'custom_emoji' && entity.custom_emoji_id) {
        customEmojiIds.push(entity.custom_emoji_id)
      }
    }
  }
  return { distinctTypes: distinctTypes.size, customEmojiIds }
}

const recordCustomEmojiIds = (user, ids) => {
  if (!ids || ids.length === 0) return
  if (!Array.isArray(user.customEmojiIds)) user.customEmojiIds = []
  const list = user.customEmojiIds
  for (const id of ids) {
    const existing = list.find(e => e && e.id === id)
    if (existing) existing.count = (existing.count || 0) + 1
    else list.push({ id, count: 1 })
  }
  list.sort((a, b) => (b.count || 0) - (a.count || 0))
  if (list.length > CUSTOM_EMOJI_CAP) list.length = CUSTOM_EMOJI_CAP
  if (typeof user.markModified === 'function') user.markModified('customEmojiIds')
}

// ---------------------------------------------------------------------------
// Public: recordMessageStats — called per group message in user-update.js
// ---------------------------------------------------------------------------

/**
 * Update all message-level stats in place on the user document.
 *
 * @param {Object} user     Mongoose User doc (or POJO in tests)
 * @param {Object} ctx      telegraf ctx
 * @returns {Object}        { mediaType, detectedLanguage, distinctFormatTypes }
 */
const recordMessageStats = (user, ctx) => {
  if (!user || !ctx) return { mediaType: null, detectedLanguage: null, distinctFormatTypes: 0 }
  const message = ctx.message || ctx.editedMessage || {}
  const isEdited = Boolean(ctx.editedMessage)
  const ms = ensureMessageStats(user)

  // ----- hour histogram (UTC) --------------------------------------------
  // Prefer Telegram's message.date when available (seconds since epoch) —
  // it's what the server saw, so it's robust to our local clock skew.
  const nowMs = (message.date && typeof message.date === 'number')
    ? message.date * 1000
    : Date.now()
  const hour = new Date(nowMs).getUTCHours()
  if (hour >= 0 && hour < 24) ms.hourHistogram[hour] = (ms.hourHistogram[hour] || 0) + 1

  // ----- message length (Welford on text+caption) ------------------------
  const text = (message.text || message.caption || '').trim()
  const textLen = text.length
  // n is globalStats.totalMessages AFTER the increment in the caller.
  // We approximate with existing totalMessages (which was already bumped).
  const n = Math.max(1, user.globalStats?.totalMessages || 1)
  welfordUpdate(ms, n, textLen)

  // ----- media type histogram -------------------------------------------
  const mediaType = getMediaType(message)
  if (mediaType) ms.mediaCounts[mediaType] = (ms.mediaCounts[mediaType] || 0) + 1
  if (mediaType === 'contact') ms.contactCount = (ms.contactCount || 0) + 1

  // ----- entity histogram + custom emoji harvest ------------------------
  const entities = message.entities || message.caption_entities || []
  const { distinctTypes, customEmojiIds } = recordEntities(ms, entities)
  if (distinctTypes > 0) ms.formattingDiversitySum = (ms.formattingDiversitySum || 0) + distinctTypes
  if (customEmojiIds.length > 0) recordCustomEmojiIds(user, customEmojiIds)

  // ----- reply / edit counters ------------------------------------------
  if (message.reply_to_message) {
    // Don't count self-replies toward "sociability" — spammers reply to
    // their own messages to avoid Telegram's link restrictions for first msg.
    const isSelfReply = Boolean(
      message.reply_to_message.from &&
      ctx.from &&
      message.reply_to_message.from.id === ctx.from.id
    )
    if (!isSelfReply) ms.replyCount = (ms.replyCount || 0) + 1
  }
  if (isEdited) ms.editCount = (ms.editCount || 0) + 1

  // ----- language detection (best-effort) -------------------------------
  let detectedLanguage = null
  if (text) {
    detectedLanguage = detectLanguage(text)
    if (detectedLanguage) recordLanguage(user, detectedLanguage)
  }

  // ----- Telegram UI language code (cheap) -----------------------------
  if (ctx.from && ctx.from.language_code && user.languageCode !== ctx.from.language_code) {
    user.languageCode = ctx.from.language_code
  }

  // ----- is_premium snapshot -------------------------------------------
  if (ctx.from && typeof ctx.from.is_premium === 'boolean') {
    if (user.isPremium !== ctx.from.is_premium) user.isPremium = ctx.from.is_premium
  }

  // Explicit markModified — Mongoose doesn't always detect deep writes on
  // subdocuments created lazily on POJO-populated sessions.
  if (typeof user.markModified === 'function') {
    user.markModified('globalStats.messageStats')
  }

  return { mediaType, detectedLanguage, distinctFormatTypes: distinctTypes }
}

// ---------------------------------------------------------------------------
// Public: bio / business intro persistence (called from spam-check.js after
// getUserChatInfo()). Keeps short history for churn detection.
// ---------------------------------------------------------------------------

const recordBio = (user, newBio) => {
  if (!user) return { changed: false }
  // Normalize falsy → empty string so unsetting bio is trackable too.
  const next = typeof newBio === 'string' ? newBio : ''
  const current = (user.bio && user.bio.text) || ''
  if (next === current) return { changed: false }

  if (!user.bio) user.bio = { text: '', updatedAt: null, history: [] }
  if (!Array.isArray(user.bio.history)) user.bio.history = []

  // Push previous value onto history (newest-first). We only push when the
  // PREVIOUS value was meaningful (non-empty) — otherwise we'd flood history
  // with empties on first observation.
  if (current) {
    user.bio.history.unshift({ value: current, seenAt: user.bio.updatedAt || new Date() })
    while (user.bio.history.length > BIO_HISTORY_CAP) user.bio.history.pop()
  }

  user.bio.text = next
  user.bio.updatedAt = new Date()
  if (typeof user.markModified === 'function') user.markModified('bio')
  return { changed: true, previous: current, next }
}

const recordBusinessIntro = (user, newText) => {
  if (!user) return { changed: false }
  const next = typeof newText === 'string' ? newText : ''
  const current = (user.businessIntro && user.businessIntro.text) || ''
  if (next === current) return { changed: false }
  if (!user.businessIntro) user.businessIntro = { text: '', updatedAt: null }
  user.businessIntro.text = next
  user.businessIntro.updatedAt = new Date()
  if (typeof user.markModified === 'function') user.markModified('businessIntro')
  return { changed: true, previous: current, next }
}

const recordPersonalChatId = (user, id) => {
  if (!user) return false
  const next = (typeof id === 'number' && Number.isFinite(id)) ? id : null
  if (user.personalChatId === next) return false
  user.personalChatId = next
  return true
}

const recordEmojiStatusId = (user, id) => {
  if (!user) return false
  const next = (typeof id === 'string' && id.length > 0) ? id : null
  if (user.emojiStatusCustomId === next) return false
  user.emojiStatusCustomId = next
  return true
}

// ---------------------------------------------------------------------------
// Public: derived-stat helpers (used by detectors, not collectors)
// ---------------------------------------------------------------------------

/**
 * Get current stdDev of message lengths, or 0 if too few samples.
 * Sample variance needs n >= 2.
 */
const getLengthStdDev = (user) => {
  const ms = user?.globalStats?.messageStats
  const n = user?.globalStats?.totalMessages || 0
  if (!ms || n < 2) return 0
  const variance = (ms.lengthM2 || 0) / (n - 1)
  return variance > 0 ? Math.sqrt(variance) : 0
}

/**
 * Reply-to-total ratio. Legitimate users in conversation-heavy groups sit
 * around 0.15-0.50; pure monologue spammers are near 0.
 */
const getReplyRatio = (user) => {
  const ms = user?.globalStats?.messageStats
  const n = user?.globalStats?.totalMessages || 0
  if (!ms || n === 0) return null
  return (ms.replyCount || 0) / n
}

/**
 * Hours with zero activity (in the 24-bucket UTC histogram).
 * Natural users sleep — they usually have 4-10 zero-hours.
 * Bots running 24/7 have 0 zero-hours once established.
 */
const getHourZeroCount = (user) => {
  const hist = user?.globalStats?.messageStats?.hourHistogram
  if (!Array.isArray(hist) || hist.length !== 24) return null
  return hist.filter(h => !h).length
}

const getTopLanguage = (user) => {
  const list = user?.detectedLanguages
  if (!Array.isArray(list) || list.length === 0) return null
  return list[0]?.code || null
}

/**
 * Ratio of hidden text_link URLs to total URLs the user has ever posted.
 *
 * Spammers prefer `text_link` entities because the VISIBLE text differs
 * from the actual URL ("click here" → scam.com), bypassing simple regex
 * filters. A legitimate user's link posting tends to be a plain URL most
 * of the time; a >= 0.5 ratio over enough samples is an evasion pattern.
 *
 * Returns null when sample size is too small to be meaningful.
 */
const HIDDEN_URL_RATIO_MIN_SAMPLES = 5
const getHiddenUrlRatio = (user) => {
  const ec = user?.globalStats?.messageStats?.entityCounts
  if (!ec) return null
  const textLinks = ec.text_link || 0
  const plain = ec.url || 0
  const total = textLinks + plain
  if (total < HIDDEN_URL_RATIO_MIN_SAMPLES) return null
  return textLinks / total
}

module.exports = {
  // Message-level ingestion
  recordMessageStats,
  getMediaType,
  detectLanguage,

  // Profile-level ingestion (called after getChat)
  recordBio,
  recordBusinessIntro,
  recordPersonalChatId,
  recordEmojiStatusId,

  // Derived accessors for detectors
  getLengthStdDev,
  getReplyRatio,
  getHourZeroCount,
  getTopLanguage,
  getHiddenUrlRatio,

  // Exposed for tests
  welfordUpdate,
  ensureMessageStats,
  DETECTED_LANGUAGES_CAP,
  CUSTOM_EMOJI_CAP,
  BIO_HISTORY_CAP
}
