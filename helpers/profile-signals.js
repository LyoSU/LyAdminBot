/**
 * Profile & content fingerprint detectors.
 *
 * Pure functions over Telegram metadata available to a Bot API client. Every
 * detector degrades gracefully — when a field is missing (e.g. user never DM'd
 * the bot, getChat returned partial data, no bio) the detector returns the
 * neutral value instead of throwing.
 *
 * Each tag added to the signals list is high-precision: a single tag can
 * inform the LLM, but only combinations are used in deterministic verdicts.
 */

const CYRILLIC = /[Ѐ-ӿԀ-ԯ]/
const LATIN = /[A-Za-z]/

// "Иoсифович" — Latin 'o' inside a Cyrillic token. Real bilingual users
// switch tokens, not letters within a token.
const hasHomoglyphMix = (text) => {
  if (!text || typeof text !== 'string') return false
  for (const token of text.split(/\s+/)) {
    if (token.length >= 2 && CYRILLIC.test(token) && LATIN.test(token)) return true
  }
  return false
}

// Generated handles: low vowel ratio, digit suffix, long consonant runs.
// Score 0..1, ≥0.7 = bot-like.
const usernameRandomnessScore = (username) => {
  if (!username) return 0
  const handle = String(username).replace(/^@/, '').toLowerCase()
  if (handle.length < 5) return 0
  let score = 0
  const letters = handle.replace(/[^a-z]/g, '')
  if (letters.length >= 4) {
    const vowels = (letters.match(/[aeiouy]/g) || []).length
    const ratio = vowels / letters.length
    if (ratio < 0.15) score += 0.4
    else if (ratio < 0.22) score += 0.2
  }
  const trailingDigits = handle.match(/\d+$/)
  if (trailingDigits && trailingDigits[0].length >= 3) score += 0.3
  else if (trailingDigits && trailingDigits[0].length >= 2) score += 0.15
  if (/[bcdfghjklmnpqrstvwxz]{5,}/i.test(handle)) score += 0.3
  return Math.min(1, score)
}

const NAME_EMOJI = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu
const countNameEmoji = (name) => name ? (name.match(NAME_EMOJI) || []).length : 0

// Zero-width / RTL / LTR override / BOM characters used to hide payloads.
// Written as escapes so the source file itself is plain ASCII.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/
const hasInvisibleChars = (text) => Boolean(text) && INVISIBLE.test(text)

// URL shortener domains seen in real Telegram scam data. Keep focused.
const SHORTENERS = new Set([
  'bit.ly', 'goo.gl', 'tinyurl.com', 'cutt.ly', 't.ly', 't.co',
  'is.gd', 'shorturl.at', 'ow.ly', 'rb.gy', 'rebrand.ly',
  'tiny.cc', 'soo.gd', 'clck.ru', 'vk.cc', 'shorte.st', 'choko.link'
])

const PRIVATE_INVITE = /(?:t|telegram)\.me\/(?:\+[\w-]+|joinchat\/[\w-]+)/i
const BOT_DEEPLINK = /t\.me\/[\w_]+bot\?start=/i

const analyzeUrls = (text) => {
  const result = { total: 0, distinctHosts: 0, shorteners: 0, privateInvites: 0, botDeeplinks: 0, punycode: 0 }
  if (!text || typeof text !== 'string') return result

  const matches = text.match(/(?:https?:\/\/|t\.me\/|telegram\.me\/|wa\.me\/)\S+/gi) || []
  const hosts = new Set()
  for (const url of matches) {
    const host = (url.match(/^(?:https?:\/\/)?([^/?#]+)/i) || [])[1]?.toLowerCase()
    if (host) {
      hosts.add(host)
      if (SHORTENERS.has(host)) result.shorteners += 1
      if (host.startsWith('xn--') || host.includes('.xn--')) result.punycode += 1
    }
    if (BOT_DEEPLINK.test(url)) result.botDeeplinks += 1
  }
  result.total = matches.length
  result.distinctHosts = hosts.size
  result.privateInvites = (text.match(PRIVATE_INVITE) || []).length
  return result
}

const BIO_PROMO = /(заробі|заработ|earn|profit|invest|crypto|btc|eth|usdt|ton|signal|канал|channel|подпис|subscribe|prize|giveaway)/i

const analyzeBio = (bio) => {
  if (!bio || typeof bio !== 'string') return null
  return {
    length: bio.length,
    urls: analyzeUrls(bio),
    mentions: (bio.match(/@[A-Za-z0-9_]{3,}/g) || []).length,
    promoTerms: BIO_PROMO.test(bio),
    invisible: hasInvisibleChars(bio)
  }
}

const countMentions = (text) => text ? (text.match(/@[A-Za-z0-9_]{3,}/g) || []).length : 0
const countHashtags = (text, entities) => {
  if (Array.isArray(entities)) return entities.filter(e => e?.type === 'hashtag').length
  return text ? (text.match(/#[A-Za-zА-Яа-я0-9_]{2,}/g) || []).length : 0
}

/**
 * Run every detector on one message + its sender profile.
 *
 * Inputs that may be missing:
 *   - userInfo: null for channel posts and ghost users
 *   - chatInfo: getChat may have failed or returned limited fields
 *   - bio/personal_chat/etc: present only when getChat succeeds
 *
 * The function returns a flat dict of facts so callers can mix it with
 * quickRiskAssessment signals without renaming anything.
 */
const analyzeMessage = (ctx, userInfo, chatInfo) => {
  const message = ctx?.message || ctx?.editedMessage || {}
  const from = ctx?.from || {}
  const text = message.text || message.caption || ''
  const entities = message.entities || message.caption_entities || []

  const displayName = [from.first_name || '', from.last_name || ''].join(' ').trim()
  const username = from.username || null

  // Sleeper: pre-2022 user_id but our DB has barely seen them.
  let sleeper = false
  const firstSeen = userInfo?.globalStats?.firstSeen
  if (firstSeen && from.id && from.id < 5000000000) {
    const ageMs = Date.now() - new Date(firstSeen).getTime()
    if (ageMs < 24 * 60 * 60 * 1000) sleeper = true
  }

  return {
    name: {
      homoglyph: hasHomoglyphMix(displayName),
      emojiCount: countNameEmoji(displayName),
      invisible: hasInvisibleChars(displayName)
    },
    username: {
      randomness: usernameRandomnessScore(username),
      missing: !username
    },
    bio: analyzeBio(chatInfo?.bio),
    activeUsernames: chatInfo?.activeUsernames?.length || 0,
    hasPrivateForwards: chatInfo?.hasPrivateForwards || false,
    hasPersonalChannel: Boolean(chatInfo?.personalChatId),
    hasEmojiStatus: Boolean(chatInfo?.emojiStatusCustomId),
    hasBirthdate: Boolean(chatInfo?.birthdate),
    languageCode: from.language_code || null,
    urls: analyzeUrls(text),
    mentionCount: countMentions(text),
    hashtagCount: countHashtags(text, entities),
    messageInvisible: hasInvisibleChars(text),
    sleeper,
    isFirstMessageEver: (userInfo?.globalStats?.totalMessages || 0) <= 1
  }
}

/**
 * Convert detector results into compact signal tags.
 *
 * IMPORTANT: validated against 2000 banned + 2000 clean users in production
 * MongoDB. The following raw detectors had FP rate >= TP rate on their own
 * (i.e. they fired equally often on legitimate accounts):
 *   - name_homoglyph (2.1% vs 1.6%)
 *   - name_emoji_spam (0.7% vs 0.8%)
 *   - stylized name chars (5.5% vs 6.0% — clean had MORE)
 *   - username_generated (3.0% vs 3.0%)
 * They are kept INTERNAL to the analysis object so deterministic rules can
 * combine them (e.g. homoglyph + new_account + promo_signal is high precision)
 * but they are NOT promoted to top-level signal tags by themselves.
 *
 * Tags that ARE promoted are URL/content patterns proven to discriminate:
 * private invites, bot deeplinks, mention chains, etc.
 */
const toSignalTags = (a) => {
  if (!a) return { signals: [], trustSignals: [] }
  const signals = []
  const trustSignals = []

  // Content patterns — high precision on their own
  if (a.urls.privateInvites > 0) signals.push('private_invite_link')
  if (a.urls.botDeeplinks > 0) signals.push('bot_deeplink')
  if (a.urls.punycode > 0) signals.push('punycode_url')
  if (a.urls.shorteners >= 2) signals.push('url_shortener') // 2+ shorteners is strong
  if (a.urls.distinctHosts >= 3) signals.push('many_distinct_links')
  if (a.mentionCount >= 5) signals.push('mention_chain') // raised from 4 — 4 mentions can be normal
  if (a.hashtagCount >= 5) signals.push('hashtag_stack')

  // Invisible characters — never appear in normal user text
  if (a.messageInvisible) signals.push('text_invisible_char')
  if (a.name.invisible) signals.push('name_invisible_char')
  if (a.bio?.invisible) signals.push('bio_invisible_char')

  // Bio: link or promo term in bio is a strong promotional intent indicator
  if (a.bio?.urls?.total > 0) signals.push('bio_has_url')
  if (a.bio?.promoTerms) signals.push('bio_promo_terms')

  // Trust signals — paid features and privacy settings real users have
  if (a.hasEmojiStatus) trustSignals.push('paid_emoji_status')
  if (a.hasBirthdate) trustSignals.push('declared_birthdate')
  if (a.hasPrivateForwards) trustSignals.push('private_forwards_enabled')

  return { signals, trustSignals }
}

module.exports = {
  hasHomoglyphMix,
  usernameRandomnessScore,
  countNameEmoji,
  hasInvisibleChars,
  analyzeUrls,
  analyzeBio,
  countMentions,
  countHashtags,
  analyzeMessage,
  toSignalTags
}
