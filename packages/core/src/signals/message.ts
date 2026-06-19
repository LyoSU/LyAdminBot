/**
 * Message-level signal extraction. Pure function over NormalizedMessage —
 * no IO, no user history (user-level signals live in user.ts).
 *
 * A signal is a fact, not a verdict: scoring decides weights, policy decides
 * actions. Trust signals carry negative: true.
 */
import type { NormalizedMessage, Signal } from '../types.js'
import { isEmojiOnly } from '../text/normalize.js'
import { classifyUrl } from './urls.js'

const LONG_TEXT_THRESHOLD = 200
const SHORT_TEXT_THRESHOLD = 50
const MANY_URL_BUTTONS_MIN = 3
const CUSTOM_EMOJI_HEAVY_MIN = 3
const RECENT_REPLY_MAX_AGE_SECONDS = 3600

// Phone numbers: international or local format with enough digits to be a
// real dial target. Spaces/dashes/parens between digit groups are allowed.
export const PHONE_REGEX = /(?:\+|\b)\d[\d ().-]{8,}\d\b/

// Cashtags: $BTC, $ETH — crypto-promo marker.
export const CASHTAG_REGEX = /\$[A-Z]{2,6}\b/

// Invisible characters used to break signature matching when injected
// INSIDE words: word joiner, zero-width space, soft hyphen, BOM.
// ZWJ/ZWNJ are deliberately excluded — legitimate in emoji sequences and
// Persian/Arabic text.
const INVISIBLE_IN_WORD_REGEX = /\p{L}[\u2060\u200B\u00AD\uFEFF]+\p{L}/u

// A "word" that mixes Cyrillic and Latin letters — homoglyph evasion
// ("Зaрaбoтoк" with Latin a/o). Per-word check avoids flagging bilingual
// sentences. Minimum length 4 to skip abbreviations.
const looksUrlLike = (s: string): boolean => /^(https?:\/\/|www\.|t\.me\/)/i.test(s.trim())

const hasMixedScriptWord = (text: string): boolean => {
  for (const word of text.split(/[\s\p{P}]+/u)) {
    if (word.length < 4) continue
    if (/[Ѐ-ӿ]/.test(word) && /[a-zA-Z]/.test(word)) return true
  }
  return false
}

export const extractMessageSignals = (msg: NormalizedMessage): Signal[] => {
  const signals: Signal[] = []
  const text = msg.text ?? ''

  // ── suspicious: structure ──────────────────────────────────────────

  if (msg.forward?.kind === 'hidden_user') {
    signals.push({ name: 'forward_hidden_user' })
  }

  const urlButtons = msg.inlineButtons.filter((b) => b.url !== null)
  if (urlButtons.length >= MANY_URL_BUTTONS_MIN) {
    signals.push({ name: 'many_url_buttons', evidence: `${urlButtons.length} URL buttons` })
  }

  // ── suspicious: URLs ───────────────────────────────────────────────

  const urlKinds = new Set<string>()
  for (const url of msg.urls) {
    // Deceptive text_link: visible text itself looks like a URL but the
    // real target differs — classic filter-evasion.
    if (url.hidden && looksUrlLike(url.visible) && url.visible.trim() !== url.target.trim()) {
      signals.push({ name: 'hidden_url', evidence: `"${url.visible}" → ${url.target}` })
    }
    urlKinds.add(classifyUrl(url.target).kind)
  }
  if (urlKinds.has('private_invite')) signals.push({ name: 'private_invite_link' })
  if (urlKinds.has('bot_deeplink')) signals.push({ name: 'bot_deeplink' })
  if (urlKinds.has('shortener')) signals.push({ name: 'url_shortener' })
  if (urlKinds.has('messenger_contact')) signals.push({ name: 'messenger_contact_link' })
  if (urlKinds.has('external')) signals.push({ name: 'external_url' })

  // ── suspicious: text content ───────────────────────────────────────

  if (PHONE_REGEX.test(text)) signals.push({ name: 'phone_number' })
  if (CASHTAG_REGEX.test(text)) signals.push({ name: 'cashtag' })
  if (text.length > LONG_TEXT_THRESHOLD) signals.push({ name: 'long_text' })
  if (INVISIBLE_IN_WORD_REGEX.test(text)) {
    signals.push({ name: 'invisible_in_word', evidence: 'invisible chars injected inside words' })
  }
  if (hasMixedScriptWord(text)) signals.push({ name: 'mixed_script_word' })

  if (msg.customEmoji.length >= CUSTOM_EMOJI_HEAVY_MIN) {
    // The alt sequence is what a human "reads" through the emoji — spammers
    // mask phone numbers and handles this way.
    const altSequence = msg.customEmoji.map((e) => e.alt).join('')
    signals.push({ name: 'custom_emoji_heavy', evidence: `alt: ${altSequence}` })
  }

  // ── suspicious: media ──────────────────────────────────────────────

  const attachmentKinds = new Set(msg.attachments.map((a) => a.kind))
  if (attachmentKinds.has('paid_media')) signals.push({ name: 'paid_media' })
  if (attachmentKinds.has('giveaway')) signals.push({ name: 'giveaway_media' })
  if (attachmentKinds.has('story')) signals.push({ name: 'story_share' })
  if (attachmentKinds.has('unknown')) signals.push({ name: 'unknown_media' })

  // ── suspicious: delivery & edits ───────────────────────────────────

  if (msg.guestBot !== null) {
    signals.push({
      name: 'guest_bot_delivery',
      evidence: msg.guestBot.botUsername ? `@${msg.guestBot.botUsername}` : `bot ${msg.guestBot.botId}`
    })
  }

  if (msg.isEdit) {
    signals.push({ name: 'edited_message' })
    const delta = msg.editDelta
    if (delta && (delta.injectedUrls > 0 || delta.injectedMentions > 0 || delta.injectedInvisibles > 0)) {
      signals.push({
        name: 'edit_injected_promo',
        evidence: `+${delta.injectedUrls} urls, +${delta.injectedMentions} mentions, +${delta.injectedInvisibles} invisibles`
      })
    }
  }

  const hasSuspicious = signals.length > 0

  // ── trust signals ──────────────────────────────────────────────────

  if (msg.replyTo && !msg.replyTo.isSelf) {
    signals.push({ name: 'is_reply', negative: true })
    const age = msg.replyTo.ageSeconds
    if (age !== null && age >= 0 && age < RECENT_REPLY_MAX_AGE_SECONDS) {
      signals.push({ name: 'recent_reply', negative: true })
    }
  }

  const stickerOrGif = attachmentKinds.has('sticker') || attachmentKinds.has('animation')
  if (stickerOrGif && !text) {
    signals.push({ name: 'media_only', negative: true })
  }

  if (text && isEmojiOnly(text)) {
    signals.push({ name: 'emoji_only', negative: true })
  }

  // Message consisting solely of t.me/telegram.me links — internal pointer,
  // not external promo.
  if (text && /^[\s\n]*((https?:\/\/)?(t\.me|telegram\.me)\/\S+[\s\n]*)+$/i.test(text)) {
    signals.push({ name: 'internal_link_only', negative: true })
  }

  if (text && text.length < SHORT_TEXT_THRESHOLD && !hasSuspicious) {
    signals.push({ name: 'short_message', negative: true })
  }

  return signals
}
