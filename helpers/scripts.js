/**
 * Unicode script detection — centralized.
 *
 * Uses Node's native regex Unicode-property escapes (`\p{Script=...}` with
 * the `u` flag) instead of hand-maintained hex ranges. Zero dependencies,
 * always up-to-date with the Unicode version the runtime ships.
 *
 * Why central module:
 *   Previously multiple helpers (contact-spam, profile-signals, profile-churn,
 *   edit-diff, message-embeddings) each embedded their own `؀-ۿ`-
 *   style ranges. When Unicode adds blocks (emoji updates, new script pages)
 *   custom hex ranges drift. `\p{Script=...}` is bound to the runtime ICU
 *   data and covers both BMP and supplementary planes correctly.
 *
 * Script-family helpers exposed here:
 *   - hasCJK   (Han / Hiragana / Katakana / Hangul — any CJK family)
 *   - hasSEA   (Thai / Lao / Khmer / Myanmar)
 *   - hasArabic
 *   - hasIndic (Devanagari / Bengali / Tamil / Telugu / Gurmukhi)
 *   - hasCyrillic
 *   - hasLatin
 *   - hasInvisible (Format characters + zero-width joiners + BOM)
 *
 * Plus `dominantScript(text)` → string identifier based on character counts,
 * useful for language-mismatch detectors when you want a single label.
 */

const PATTERNS = {
  cjk: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
  sea: /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u,
  arabic: /\p{Script=Arabic}/u,
  indic: /[\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Gurmukhi}]/u,
  cyrillic: /\p{Script=Cyrillic}/u,
  latin: /\p{Script=Latin}/u
}

// "Invisible" covers zero-width joiners, directional overrides, BOM —
// everything that renders as no visible glyph but alters text semantics.
// `\p{Cf}` (Format) already includes U+200B/C/D, U+202A-E, U+2060-F,
// U+FEFF and all the RLO/LRO/PDI et al. used in homoglyph attacks.
const INVISIBLE_REGEX = /\p{Cf}/u
const INVISIBLE_REGEX_GLOBAL = /\p{Cf}/gu

const hasCJK = (text) => typeof text === 'string' && PATTERNS.cjk.test(text)
const hasSEA = (text) => typeof text === 'string' && PATTERNS.sea.test(text)
const hasArabic = (text) => typeof text === 'string' && PATTERNS.arabic.test(text)
const hasIndic = (text) => typeof text === 'string' && PATTERNS.indic.test(text)
const hasCyrillic = (text) => typeof text === 'string' && PATTERNS.cyrillic.test(text)
const hasLatin = (text) => typeof text === 'string' && PATTERNS.latin.test(text)
const hasInvisible = (text) => typeof text === 'string' && INVISIBLE_REGEX.test(text)

/**
 * Return the script-family that dominates the text (by character count).
 * Non-letter characters (digits, punctuation, spaces) are ignored so a
 * message like "call +1234" doesn't get classified by its digits.
 *
 * Ties and "no letters at all" return null — callers should treat null
 * as "unknown" rather than force a default.
 */
const dominantScript = (text) => {
  if (!text || typeof text !== 'string') return null
  const counts = { cjk: 0, sea: 0, arabic: 0, indic: 0, cyrillic: 0, latin: 0 }
  for (const ch of text) {
    if (PATTERNS.cjk.test(ch)) counts.cjk++
    else if (PATTERNS.sea.test(ch)) counts.sea++
    else if (PATTERNS.arabic.test(ch)) counts.arabic++
    else if (PATTERNS.indic.test(ch)) counts.indic++
    else if (PATTERNS.cyrillic.test(ch)) counts.cyrillic++
    else if (PATTERNS.latin.test(ch)) counts.latin++
  }
  let best = null
  let bestCount = 0
  for (const [script, count] of Object.entries(counts)) {
    if (count > bestCount) { best = script; bestCount = count }
  }
  return bestCount > 0 ? best : null
}

/**
 * Return true if any token in `text` mixes Latin + a non-Latin script
 * within the same whitespace-delimited run. This is the classic homoglyph
 * spoofing marker ("Viаgra" with Cyrillic а, "ℂlaim" with mathematical Cl).
 */
const hasScriptMixWithinToken = (text) => {
  if (!text || typeof text !== 'string') return false
  for (const tok of text.split(/\s+/)) {
    if (!tok) continue
    const latin = PATTERNS.latin.test(tok)
    if (!latin) continue
    if (PATTERNS.cyrillic.test(tok) || PATTERNS.cjk.test(tok) ||
        PATTERNS.arabic.test(tok) || PATTERNS.indic.test(tok)) {
      return true
    }
  }
  return false
}

const stripInvisible = (text) => typeof text === 'string'
  ? text.replace(INVISIBLE_REGEX_GLOBAL, '')
  : text

module.exports = {
  PATTERNS,
  INVISIBLE_REGEX,
  INVISIBLE_REGEX_GLOBAL,
  hasCJK,
  hasSEA,
  hasArabic,
  hasIndic,
  hasCyrillic,
  hasLatin,
  hasInvisible,
  hasScriptMixWithinToken,
  dominantScript,
  stripInvisible
}
