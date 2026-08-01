/**
 * Message-level signal extraction. Pure function over NormalizedMessage —
 * no IO, no user history (user-level signals live in user.ts).
 *
 * A signal is a fact, not a verdict: scoring decides weights, policy decides
 * actions. Whether a signal accuses or exonerates is declared once, in the
 * catalogue (`registry.ts`), not repeated at each raise site.
 */
import type { NormalizedMessage, Signal } from '../types.js'
import { isEmojiOnly } from '../text/normalize.js'
import { mixesConfusableScripts } from '../text/script.js'
import { classifyUrl, sameDestination } from './urls.js'

const LONG_TEXT_THRESHOLD = 200
const SHORT_TEXT_THRESHOLD = 50

/**
 * Longest emoji-only text still read as a reaction rather than as content.
 *
 * Counted in codepoints, not UTF-16 units, because one emoji can be many: a ZWJ
 * family is 7 codepoints (11 units) and a flag is 2, so a bar meaning "a few
 * emoji" has to be generous enough for three of the largest. 32 sits well above
 * three family emoji (21) and well below the production mural (88).
 */
const EMOJI_ONLY_MAX_CODEPOINTS = 32

const codepointLength = (text: string): number => [...text].length
const MANY_URL_BUTTONS_MIN = 3
const CUSTOM_EMOJI_HEAVY_MIN = 3
const RECENT_REPLY_MAX_AGE_SECONDS = 3600

/**
 * A number long enough to dial, in whichever shape the writer groups it:
 * international or local, with spaces, dashes, dots or parens between groups.
 *
 * The bound counts DIGITS, not characters of the run. It used to be
 * `\d[\d ().-]{8,}\d` — a length bound on a class that includes the separators,
 * so any ten characters drawn from digits, spaces, dots, dashes and parens
 * matched however few digits they actually held. Ordinary chat produces those
 * constantly: grouped thousands, salary ranges, numbered lists, dotted dates.
 * That is not a free extra signal — `phone_number` weighs above the bar for
 * enforcing without reading the text, and being a `promo` signal it also
 * withdraws the shortcut that spares established regulars the pipeline, so a
 * member quoting a price drew the handling built for adverts (2026-08-01).
 *
 * Nine digits is the floor: below it lie the grouped thousands and the dotted
 * dates, above it every national format we care about. At most two separator
 * characters may sit between two digits, which admits `+38 (067) 123-45-67`
 * (`" ("` and `") "`) while a range's `" - "` breaks the run in two.
 */
export const PHONE_REGEX = /(?:\+|\b)\d(?:[ ().-]{0,2}\d){8,}\b/

// Cashtags: $BTC, $ETH — crypto-promo marker.
export const CASHTAG_REGEX = /\$[A-Z]{2,6}\b/

// Invisible characters used to break signature matching when injected
// INSIDE words: word joiner, zero-width space, soft hyphen, BOM.
// ZWJ/ZWNJ are deliberately excluded — legitimate in emoji sequences and
// Persian/Arabic text.
/**
 * Zero-width characters wedged inside a word: deliberate obfuscation only.
 *
 * SOFT HYPHEN (U+00AD) and BOM (U+FEFF) used to be in this class and are not
 * any more (2026-07-30). At weight 2.0 this signal on its own clears the bar
 * for removing the sender, and both of those characters arrive by accident \u2014
 * a soft hyphen from pasting hyphenated text out of a document or a justified
 * web page, a BOM from a broken encoding pipeline. Nothing is lost: every
 * \p{Cf} is stripped before hashing and embedding, so these cannot evade the
 * signature or vector layers regardless of whether a signal fires here.
 */
const INVISIBLE_IN_WORD_REGEX = /\p{L}[\u2060\u200B]+\p{L}/u

const looksUrlLike = (s: string): boolean => /^(https?:\/\/|www\.|t\.me\/)/i.test(s.trim())

// A "word" borrowing letters from a look-alike alphabet — homoglyph evasion
// ("Зaрaбoтoк" with Latin a/o). Which alphabets count as look-alike is
// `mixesConfusableScripts`. Per-word so bilingual sentences are not flagged;
// minimum length 4 to skip abbreviations.
const hasMixedScriptWord = (text: string): boolean => {
  for (const word of text.split(/[\s\p{P}]+/u)) {
    if (word.length < 4) continue
    if (mixesConfusableScripts(word)) return true
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
    // Deceptive text_link: the visible text is itself a URL, but clicking takes
    // you somewhere else — classic filter-evasion. "Somewhere else" is a
    // destination, not a spelling: see `sameDestination`.
    if (url.hidden && looksUrlLike(url.visible) && !sameDestination(url.visible, url.target)) {
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
    signals.push({ name: 'is_reply' })
    const age = msg.replyTo.ageSeconds
    if (age !== null && age >= 0 && age < RECENT_REPLY_MAX_AGE_SECONDS) {
      signals.push({ name: 'recent_reply' })
    }
  }

  const stickerOrGif = attachmentKinds.has('sticker') || attachmentKinds.has('animation')
  if (stickerOrGif && !text) {
    signals.push({ name: 'media_only' })
  }

  /**
   * An emoji-only message is a reaction — a nod, a laugh, applause — and earns
   * the same discount as a sticker. Two conditions on that, both learned from
   * one production message on 2026-07-31 (88 codepoints of coloured squares
   * arranged to spell words, discounted 1.5 for being "a reaction"):
   *
   *  - No CUSTOM emoji. What sits in `text` for a custom emoji is a fallback
   *    character chosen by whoever built the pack; the reader sees an arbitrary
   *    image instead. So the codepoints saying "this is a laugh" are authored by
   *    the sender and mean nothing about what was actually displayed — the same
   *    deception `hidden_url` exists to catch, where the visible form and the
   *    real one are set independently. Worse, `custom_emoji_heavy` had already
   *    raised 0.8 about exactly these entities, and this handed back 1.5.
   *
   *  - Short enough to be a reaction. Past a certain length emoji stop being a
   *    response and become a medium: a wall of blocks spelling words is content,
   *    and it is the one shape of content NO text stage can read — the signature
   *    layer strips emoji before hashing, the embedding collapses emoji-only
   *    text, the moderation port sees no words. Trust was discounting precisely
   *    the messages we are blindest to.
   *
   * Neither condition accuses anyone: an emoji mural is not by itself spam, so
   * both withhold a discount rather than adding suspicion.
   */
  const plainEmojiReaction = msg.customEmoji.length === 0 &&
    codepointLength(text) <= EMOJI_ONLY_MAX_CODEPOINTS
  if (text && isEmojiOnly(text) && plainEmojiReaction) {
    signals.push({ name: 'emoji_only' })
  }

  // Message consisting solely of t.me/telegram.me links — internal pointer,
  // not external promo.
  if (text && /^[\s\n]*((https?:\/\/)?(t\.me|telegram\.me)\/\S+[\s\n]*)+$/i.test(text)) {
    signals.push({ name: 'internal_link_only' })
  }

  if (text && text.length < SHORT_TEXT_THRESHOLD && !hasSuspicious) {
    signals.push({ name: 'short_message' })
  }

  return signals
}
