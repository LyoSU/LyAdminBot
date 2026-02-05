/**
 * Shared text utilities for content detection across spam pipeline.
 *
 * Centralizes emoji regex and textual content detection to prevent
 * drift between spam-signatures, velocity, embeddings, and spam-check.
 */

// Comprehensive emoji regex covering all major Unicode emoji ranges:
// - Miscellaneous Symbols & Pictographs, Emoticons, Transport, Flags (1F300-1F9FF)
// - Misc Symbols (2600-26FF), Dingbats (2700-27BF)
// - Variation Selectors (FE00-FE0F), ZWJ (200D), Combining Enclosing Keycap (20E3)
// - Symbols Extended-A (1FA00-1FAFF), Misc Technical (2300-23FF)
// - Arrows (2B05-2B07), Squares (2B1B-2B1C)
// - CJK enclosed (3030, 303D, 3297, 3299)
// - Tag characters for flag sequences (E0020-E007F)
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{200D}]|[\u{20E3}]|[\u{1FA00}-\u{1FAFF}]|[\u{2300}-\u{23FF}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]|[\u{E0020}-\u{E007F}]/gu

/**
 * Strip all emoji characters from text.
 * Uses comprehensive regex covering all known Unicode emoji ranges.
 */
const stripEmoji = (text) => {
  if (!text) return ''
  return text.replace(EMOJI_REGEX, '')
}

/**
 * Check if text has meaningful textual content (not just emoji/whitespace).
 * Returns false for emoji-only, pure whitespace, or very short text.
 *
 * Used by spam-signatures, velocity, and embeddings to skip processing
 * that would produce hash/embedding collisions for non-textual messages.
 *
 * @param {string} text - Raw message text
 * @param {number} [minLength=5] - Minimum non-emoji chars to be considered textual
 * @returns {boolean}
 */
const hasTextualContent = (text, minLength = 5) => {
  if (!text) return false
  const stripped = stripEmoji(text).replace(/\s+/g, '').trim()
  return stripped.length >= minLength
}

/**
 * Inverse of hasTextualContent — true if message is emoji-only.
 * Convenience alias for readability in guards like `if (isEmojiOnly(text)) return`.
 */
const isEmojiOnly = (text) => {
  if (!text) return false
  return !hasTextualContent(text)
}

module.exports = {
  EMOJI_REGEX,
  stripEmoji,
  hasTextualContent,
  isEmojiOnly
}
