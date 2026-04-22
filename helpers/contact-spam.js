/**
 * Contact-spam detector — STRUCTURAL signals only, no word/country lists.
 *
 * Why structural-only: keyword and country-code lists rot fast, carry
 * language bias, and are trivially bypassed. Legitimate users in every
 * region exist; promo words drift across languages every week. Instead
 * we rely on structural anomalies in the Telegram `contact` payload that
 * a human sharing a real contact never produces.
 *
 * Layered signals (each structural, language-agnostic):
 *   - `contact_foreign_script`    name in a non-Latin, non-Cyrillic script
 *                                 (CJK / Thai / Khmer / Arabic / Indic).
 *                                 Legitimate cross-culture contacts exist,
 *                                 but combined with other anomalies this is
 *                                 a strong coordinated-campaign marker.
 *   - `contact_script_mix`        the contact name mixes Latin and a
 *                                 non-Latin script within the same token
 *                                 ("Steven李") — homoglyph-style masking.
 *   - `contact_url_in_name`       URL / t.me / @mention text inside the
 *                                 first_name or last_name fields. No human
 *                                 puts URLs in a contact name.
 *   - `contact_digits_in_name`    >= 4 consecutive digits in the name.
 *                                 Real names don't contain account numbers.
 *   - `contact_invisible_in_name` zero-width / RTL-override / BOM chars
 *                                 in the name. These exist only to hide
 *                                 payloads and never appear legitimately.
 *   - `foreign_contact`           contact.user_id != sender.id (not own).
 *
 * Rules (verdict short-circuit — all high-precision, no keyword lookups):
 *
 *   Rule 1 "contact_name_structural_anomaly"
 *     Any of {url in name, digits in name, invisible chars in name} fires
 *     on its own. Confidence 95. These patterns are zero-FP in real contacts.
 *
 *   Rule 2 "contact_foreign_script_suspicious"
 *     Foreign script in name + NOT ownContact + NEW user.
 *     Confidence 92. Covers the Chinese / SEA contact-card attack pattern
 *     without naming any countries or keywords.
 *
 *   Rule 3 "contact_script_mix_new_user"
 *     Script-mixing inside a single token + new user. Confidence 90.
 *
 *   Rule 4 "contact_repeat_sender"
 *     User already has contactCount >= 2 foreign contacts AND is sending
 *     another foreign contact. Confidence 90. Purely behavioural.
 *
 * None of these require maintaining an evolving keyword list. New scripts
 * are already covered by the Unicode range tests; new countries need no
 * special-casing.
 */

// ---------------------------------------------------------------------------
// Unicode script ranges (escape form — keeps source ASCII-only)
// ---------------------------------------------------------------------------

// CJK Unified Ideographs + extensions + Hiragana + Katakana + Hangul + fullwidth
const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/

// Thai + Lao + Khmer + Myanmar
const SEA_RE = /[\u0E00-\u0E7F\u0E80-\u0EFF\u1780-\u17FF\u1000-\u109F]/

// Arabic + Persian + Urdu
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/

// Devanagari + Bengali + Tamil + Telugu
const INDIC_RE = /[\u0900-\u097F\u0980-\u09FF\u0B80-\u0BFF\u0C00-\u0C7F]/

// Latin letters (used for script-mix detection)
const LATIN_LETTER_RE = /[A-Za-z]/

// Cyrillic letters
const CYRILLIC_LETTER_RE = /[\u0400-\u04FF]/

// Invisible / formatting chars — never appear in real names
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/

// URL / mention / telegram link inside a contact name
// (plain-text URLs, t.me/telegram.me links, wa.me, @mentions ≥4 chars)
const URL_IN_NAME_RE = /https?:\/\/|t\.me\/|telegram\.me\/|wa\.me\/|@[A-Za-z0-9_]{4,}/i

// 4+ consecutive digits — real given names never contain digit runs
const DIGITS_IN_NAME_RE = /\d{4,}/

// ---------------------------------------------------------------------------
// Script classification (used for the foreign-script signal)
// ---------------------------------------------------------------------------

const detectForeignScript = (text) => {
  if (!text || typeof text !== 'string') return null
  if (CJK_RE.test(text)) return 'cjk'
  if (SEA_RE.test(text)) return 'sea'
  if (ARABIC_RE.test(text)) return 'arabic'
  if (INDIC_RE.test(text)) return 'indic'
  return null
}

/**
 * True if the text mixes Latin with Cyrillic OR Latin with a non-Latin
 * non-Cyrillic script within the SAME token. A bilingual person writes
 * tokens in one script at a time; mid-token mixing is a homoglyph tell.
 */
const hasScriptMix = (text) => {
  if (!text || typeof text !== 'string') return false
  for (const token of text.split(/\s+/)) {
    if (token.length < 2) continue
    const hasLatin = LATIN_LETTER_RE.test(token)
    const hasCyrillic = CYRILLIC_LETTER_RE.test(token)
    const hasForeign = CJK_RE.test(token) || SEA_RE.test(token) ||
      ARABIC_RE.test(token) || INDIC_RE.test(token)
    if ((hasLatin && hasCyrillic) || (hasLatin && hasForeign) || (hasCyrillic && hasForeign)) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Main detector
// ---------------------------------------------------------------------------

/**
 * @param {Object} ctx    telegraf ctx
 * @param {Object} user   Mongoose User doc (session.userInfo) or null
 * @param {Object} userCtx buildUserContext result (for isNewAccount)
 */
const analyzeContactMessage = (ctx, user, userCtx) => {
  const message = ctx?.message || ctx?.editedMessage
  const contact = message && message.contact
  if (!contact) {
    return { isContact: false, fields: {}, verdict: null, signals: [] }
  }

  const fromId = ctx?.from?.id
  const firstName = contact.first_name || ''
  const lastName = contact.last_name || ''
  const name = (firstName + ' ' + lastName).trim()
  const phone = contact.phone_number || ''
  const contactUserId = contact.user_id || null

  const fields = {
    hasFirstName: Boolean(firstName),
    hasLastName: Boolean(lastName),
    phoneDigitsLen: phone.replace(/[^0-9]/g, '').length,
    foreignScript: detectForeignScript(name),
    scriptMix: hasScriptMix(name),
    invisibleInName: INVISIBLE_RE.test(name),
    urlInName: URL_IN_NAME_RE.test(name),
    digitsInName: DIGITS_IN_NAME_RE.test(name),
    foreignContact: Boolean(contactUserId && fromId && contactUserId !== fromId),
    ownContact: Boolean(contactUserId && fromId && contactUserId === fromId),
    nameLength: name.length
  }

  const signals = []
  if (fields.foreignScript) signals.push('contact_foreign_script')
  if (fields.scriptMix) signals.push('contact_script_mix')
  if (fields.invisibleInName) signals.push('contact_invisible_in_name')
  if (fields.urlInName) signals.push('contact_url_in_name')
  if (fields.digitsInName) signals.push('contact_digits_in_name')
  if (fields.foreignContact) signals.push('foreign_contact')

  // -------- verdicts ------------------------------------------------------

  const messageCount = userCtx?.messageCount || 0
  const globalMessages = userCtx?.globalMessageCount || user?.globalStats?.totalMessages || 0
  const contactCount = user?.globalStats?.messageStats?.contactCount || 0
  const isNew = Boolean(userCtx?.isNewAccount) || messageCount <= 1 || globalMessages <= 2

  // Rule 1 — structural anomaly in the name itself. Zero legitimate cases.
  if (fields.invisibleInName || fields.urlInName || fields.digitsInName) {
    return {
      isContact: true,
      fields,
      signals,
      verdict: {
        decision: 'spam',
        rule: 'contact_name_structural_anomaly',
        confidence: 95,
        reason: 'Contact name contains URL / digits / invisible characters (structural anomaly)'
      }
    }
  }

  // Rule 2 — foreign-script name + not-own contact + new user. Covers the
  // prod Chinese-contact-card attack without any country or keyword list.
  if (fields.foreignScript && !fields.ownContact && isNew) {
    return {
      isContact: true,
      fields,
      signals,
      verdict: {
        decision: 'spam',
        rule: 'contact_foreign_script_suspicious',
        confidence: 92,
        reason: `New user sharing a ${fields.foreignScript}-script contact that is not their own`
      }
    }
  }

  // Rule 3 — script-mixing inside a token + new user. Classic homoglyph-
  // style obfuscation carried into a contact card.
  if (fields.scriptMix && !fields.ownContact && isNew) {
    return {
      isContact: true,
      fields,
      signals,
      verdict: {
        decision: 'spam',
        rule: 'contact_script_mix_new_user',
        confidence: 90,
        reason: 'New user sharing a contact whose name mixes scripts inside a single token'
      }
    }
  }

  // Rule 4 — behavioural: already known as a repeat foreign-contact sender.
  if (fields.foreignContact && contactCount >= 2) {
    return {
      isContact: true,
      fields,
      signals,
      verdict: {
        decision: 'spam',
        rule: 'contact_repeat_sender',
        confidence: 90,
        reason: `User has shared ${contactCount}+ foreign contacts (scam pattern)`
      }
    }
  }

  return { isContact: true, fields, signals, verdict: null }
}

module.exports = {
  analyzeContactMessage,
  detectForeignScript,
  hasScriptMix
}
