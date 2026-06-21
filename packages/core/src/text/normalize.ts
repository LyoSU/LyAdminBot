/**
 * Text normalization shared by every content detector.
 *
 * One source of truth for emoji/invisible-char handling. The v1 codebase
 * had three drifted copies of this logic, which produced the emoji-only
 * hash-collision bug class (identical hashes/embeddings for unrelated
 * messages). Keep it here and nowhere else.
 */

// Covers the major Unicode emoji ranges plus joiners/selectors so that
// ZWJ sequences and keycaps are removed entirely (no stray combiners left).
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|\u{200D}|\u{20E3}|[\u{1FA00}-\u{1FAFF}]|[\u{2300}-\u{23FF}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|\u{3030}|\u{303D}|\u{3297}|\u{3299}|[\u{E0020}-\u{E007F}]/gu

/**
 * Unicode Format category (zero-width, directional marks, BOM, tags, …) plus
 * unpaired surrogates. The lone-surrogate clause is what keeps stripInvisible
 * idempotent: a Format char sitting between an unpaired high and low surrogate
 * would, once removed, leave those two surrogates adjacent — and they can then
 * combine into a supplementary-plane code point that is itself a Format char
 * (e.g. U+E0001), which a second pass would strip. Dropping lone surrogates up
 * front makes that merge impossible. Valid surrogate pairs are left untouched.
 */
const INVISIBLE_REGEX = /\p{Cf}|[\uD800-\uDFFF]/gu

export const stripEmoji = (text: string): string => text.replace(EMOJI_REGEX, '')

export const stripInvisible = (text: string): string => text.replace(INVISIBLE_REGEX, '')

/**
 * True when the message carries enough non-emoji, non-invisible characters
 * to be worth hashing/embedding/classifying as text.
 */
export const hasTextualContent = (text: string, minLength = 5): boolean => {
  if (!text) return false
  const stripped = stripInvisible(stripEmoji(text)).replace(/\s+/g, '')
  return stripped.length >= minLength
}

export const isEmojiOnly = (text: string): boolean =>
  text.length > 0 && !hasTextualContent(text)
