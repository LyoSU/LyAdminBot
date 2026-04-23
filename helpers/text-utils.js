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

/**
 * Render a unicode progress-bar of `len` cells representing `percent` (0..100).
 *
 * Pure, stateless, side-effect-free — safe for unit tests and locale strings.
 * Used by /settings antispam sensitivity screen and (later, Plan 8) stats.
 *
 * @param {number} percent - 0..100. Clamped. NaN/null → 0.
 * @param {number} [len=10] - Number of cells in the bar.
 * @param {object} [chars] - Override bar glyphs.
 * @param {string} [chars.full='▮']
 * @param {string} [chars.empty='▱']
 * @returns {string}
 */
const bar = (percent, len = 10, chars) => {
  const glyphs = chars || {}
  const full = glyphs.full || '▮'
  const empty = glyphs.empty || '▱'
  const cellCount = Math.max(1, Math.floor(len))
  let p = Number(percent)
  if (!Number.isFinite(p)) p = 0
  if (p < 0) p = 0
  if (p > 100) p = 100
  const filled = Math.round((p / 100) * cellCount)
  return full.repeat(filled) + empty.repeat(cellCount - filled)
}

/**
 * Char-level truncation with ellipsis. Not grapheme-perfect (emoji ZWJ
 * sequences can split) — acceptable for button previews where the caller
 * already caps input length at 200 chars.
 *
 * @param {string} str
 * @param {number} max - Max visible length (including the ellipsis character).
 * @param {string} [ellipsis='…']
 */
const truncate = (str, max, ellipsis = '…') => {
  if (!str) return ''
  const s = String(str)
  const limit = Math.max(1, Math.floor(max))
  if (s.length <= limit) return s
  const keep = Math.max(0, limit - ellipsis.length)
  return s.slice(0, keep) + ellipsis
}

/**
 * Escape the four characters that would otherwise break a parse_mode=HTML
 * Telegram message: <, >, &, ". Works on null/undefined (returns empty).
 */
const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

module.exports = {
  EMOJI_REGEX,
  stripEmoji,
  hasTextualContent,
  isEmojiOnly,
  bar,
  truncate,
  escapeHtml
}
