/**
 * Abstain gate: decides whether a message carries enough classifiable
 * information to be worth scoring at all.
 *
 * Fixes the "bare @username" verdict-roulette class: when a human can't
 * tell whether a message is spam, the LLM can't either — asking it just
 * produces noise. Low-information messages get `observe` and accumulate
 * in the sender's session buffer instead.
 */

import type { NormalizedMessage } from '../types.js'
import { handleSpans, stripEmoji, stripInvisible } from './normalize.js'
import { informativeLength } from './script.js'

export type AbstainInput = Pick<
  NormalizedMessage,
  'text' | 'urls' | 'mentions' | 'attachments' | 'inlineButtons' | 'forward' | 'customEmoji'
  | 'guestBot' | 'replyTo'
>

/** What the pipeline has already worked out by the time it asks this. */
export interface AbstainContext {
  /**
   * A word in this message borrows letters from a look-alike alphabet in the
   * way that has no innocent reading — `greek_homoglyph_word`, raised by
   * `extractMessageSignals` well before this gate is consulted.
   *
   * Passed in rather than re-derived here, because a second scan for the same
   * thing is a second definition of it, and the two would eventually disagree.
   */
  obfuscated?: boolean
  /**
   * Nobody here knows them: inside their first few messages in this chat AND
   * carrying no standing anywhere — see `isStrangerHere`.
   *
   * Both halves are needed. `new_in_chat` alone is true for the first three
   * messages of ANY account, including one with three hundred messages
   * elsewhere walking into a chat it has not posted in before; that person
   * naming somebody is a person naming somebody.
   */
  stranger?: boolean
}

/**
 * Minimum content (after stripping mentions, emoji, invisibles and whitespace)
 * for a text-only message to be classified.
 *
 * Measured by `informativeLength`, not by codepoint count. Counting codepoints
 * assumes one of them is worth one letter, which is false for logographic
 * scripts: a complete advert of ten Han characters measured shorter than a
 * two-word greeting and was waved through as too little to judge (2026-07-31).
 */
const MIN_INFORMATIVE_CHARS = 20

/**
 * 3+ custom emoji is treated as potential symbol masking (rendering
 * content the raw text doesn't show); 1-2 are decoration.
 */
const CUSTOM_EMOJI_MASKING_MIN = 3

/**
 * Anything a person actually said: one letter, in any script.
 *
 * Digits are excluded on purpose. `+1 @vasya` and `2 @oleh` agree with somebody
 * present; not one of the sixteen adverts this rule was measured against needs a
 * digit to qualify, so letting digits count would only widen it towards the
 * population it is meant to leave alone.
 */
const SAYS_SOMETHING = /\p{L}/u

/**
 * A handle with something somebody SAID in front of it.
 *
 * "Mentions are addressing" is true when the handle names somebody in the
 * conversation, and a salutation comes first — that is where both people and
 * Telegram's own clients put it. A handle arriving after words is being pointed
 * at, not spoken to, and what it points at is somewhere else.
 *
 * Three things the prefix is not allowed to be, each of them a way the plain
 * question "is anything before it" answers wrongly:
 *
 *  - Another handle. `@a @b @c` would otherwise find `@a` sitting in front of
 *    `@b` and call it content, re-opening this gate on the bare-handle class it
 *    was built to close. Every handle is masked out, not just the current one.
 *  - Emoji and invisibles, for the same reason the length test drops them:
 *    `🧧 @channel` is a bare handle with decoration.
 *  - Punctuation or a bare number. `=> @handle` and `+1 @user` have something
 *    before the handle and nobody said any of it, so the prefix must carry a
 *    letter.
 *
 * Position is measured in the string, and that is a fair objection: a spammer
 * who leads with the handle is read as greeting somebody. The order-blind
 * alternative — letting each handle contribute partial credit toward the length
 * bar — was swept against the same corpus and does not separate the two
 * populations at any setting. The lowest credit that reaches everything these
 * two rules catch also lifts sixty other messages out of the buffer, and the
 * cheapest setting that catches most of them still lifts twenty-two. Residual
 * length alone does not know the difference between a slogan and a question;
 * where the handle sits does.
 */
/** The text with every handle blanked out, same length so spans still address it. */
const maskHandles = (text: string, spans: { start: number; end: number }[]): string =>
  spans.reduce(
    (acc, span) => acc.slice(0, span.start) + ' '.repeat(span.end - span.start) + acc.slice(span.end),
    text
  )

/** Did anybody say anything in this, once handles and decoration are gone. */
const spoken = (text: string): boolean =>
  SAYS_SOMETHING.test(stripInvisible(stripEmoji(text)))

const pointsOutward = (text: string): boolean => {
  const spans = handleSpans(text)
  if (spans.length === 0) return false
  const masked = maskHandles(text, spans)
  return spans.some((span) => spoken(masked.slice(0, span.start)))
}

/**
 * Nothing in the message but handles, and every one of them a bot.
 *
 * The complement of `pointsOutward`, and the case it structurally cannot see: a
 * drop with no words in it has no prose for a handle to trail. Measured
 * 2026-08-26 over 3680 decisions the bot let stand, this shape matched ten —
 * every one from an account new to its chat, none acted on — and matched zero
 * of the 1293 whose sender carried standing or a trust grant.
 *
 * The contrast set settles it: one of those exact texts also appears among the
 * bans, as `guest_bot_promo`. The same message is both ban-worthy and "too
 * little to judge" depending on which stage reaches it first, because the
 * campaign rotates handles — sixteen of them across seven combinations — so
 * signatures keep missing and the buffer only concludes once five have piled up.
 *
 * Bots specifically. Tagging three admins, crediting friends or listing a roster
 * are all people, which is the objection this has to survive; Telegram requires
 * a bot username to end in "bot", so the difference is readable from the text.
 * Two, not one, because "@somebot" alone is somebody asking a bot something.
 */
const BOT_HANDLE = /bot$/i
const BOT_DROP_MIN_HANDLES = 2

const nothingButBots = (text: string): boolean => {
  const spans = handleSpans(text)
  if (spans.length < BOT_DROP_MIN_HANDLES) return false
  if (!spans.every((span) => BOT_HANDLE.test(text.slice(span.start + 1, span.end)))) return false
  return !spoken(maskHandles(text, spans))
}

export const shouldAbstain = (
  input: AbstainInput,
  context: AbstainContext = {}
): boolean => {
  // Rich content is always classifiable regardless of text length:
  // URLs, buttons, forwards, and media carry signal on their own.
  if (input.urls.length > 0) return false
  if (input.inlineButtons.length > 0) return false
  if (input.forward !== null) return false
  if (input.attachments.length > 0) return false
  // Guest-bot deliveries exist to post content — always classify them.
  if (input.guestBot !== null) return false
  // Custom-emoji-heavy messages may render text the raw string hides.
  if (input.customEmoji.length >= CUSTOM_EMOJI_MASKING_MIN) return false
  /**
   * A word built out of two alphabets belongs in the list above: somebody took
   * trouble over it, and the trouble is itself the thing worth reading. Not
   * conditioned on the sender, unlike the two rules below — across 1293
   * messages from senders the chat trusted, not one carried such a word.
   *
   * Production 2026-08-26: `ρаздаю деньги сейчас` measured 18 informative
   * characters against a bar of 20, so the finding the pipeline had already
   * made about it reached nothing that could act on it.
   */
  if (context.obfuscated === true) return false

  /**
   * A pointer to another account, from somebody this chat has never met, in a
   * message that answers nobody. Classifiable for the same reason a URL is:
   * `t.me/handle` and `@handle` are the same pointer, and until 2026-08-26 the
   * first was always classified and the second always stripped.
   *
   * Both conditions carry weight. A reply names somebody present, so its handle
   * really is addressing. And the stranger is the whole point: measured over one
   * retention window, every trailing handle from a sender nobody here knew was
   * an advert (16 of 16) and every one from a member the chat knew was ordinary
   * conversation (9 of 9).
   *
   * `replyTo` is null for a reply we could not verify, and that is deliberate
   * upstream (2026-07-30: an unverified reply is not a reply, because replying
   * to anything was the cheapest evasion in the system). It stays deliberate
   * here for the same reason — otherwise the way past this rule is to reply to
   * a message that no longer exists. A comment under a channel post is likewise
   * not a reply: it answers a POST, and a handle in it names nobody present.
   */
  if (context.stranger === true && input.replyTo === null && pointsOutward(input.text)) return false
  if (context.stranger === true && nothingButBots(input.text)) return false

  // Mentions are addressing, not content — a bare "@user" tells us nothing.
  const withoutMentions = input.text.replace(/@\w+/g, ' ')
  const informative = stripInvisible(stripEmoji(withoutMentions)).replace(/\s+/g, '')
  return informativeLength(informative) < MIN_INFORMATIVE_CHARS
}
