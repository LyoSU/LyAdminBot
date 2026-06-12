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
import { stripEmoji, stripInvisible } from './normalize.js'

export type AbstainInput = Pick<
  NormalizedMessage,
  'text' | 'urls' | 'mentions' | 'attachments' | 'inlineButtons' | 'forward' | 'customEmoji' | 'guestBot'
>

/**
 * Minimum informative characters (after stripping mentions, emoji,
 * invisibles, and whitespace) for a text-only message to be classified.
 */
const MIN_INFORMATIVE_CHARS = 20

/**
 * 3+ custom emoji is treated as potential symbol masking (rendering
 * content the raw text doesn't show); 1-2 are decoration.
 */
const CUSTOM_EMOJI_MASKING_MIN = 3

export const shouldAbstain = (input: AbstainInput): boolean => {
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

  // Mentions are addressing, not content — a bare "@user" tells us nothing.
  const withoutMentions = input.text.replace(/@\w+/g, ' ')
  const informative = stripInvisible(stripEmoji(withoutMentions)).replace(/\s+/g, '')
  return informative.length < MIN_INFORMATIVE_CHARS
}
