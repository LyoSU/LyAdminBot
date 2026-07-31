/**
 * Signature hashing — BYTE-COMPATIBLE port of v1 helpers/spam-signatures.js.
 *
 * Compatibility is a hard requirement: v2 must match the 7k+ signatures
 * already in production Mongo. Do not "improve" the normalization without
 * a migration plan — any change silently orphans every existing hash.
 */
import { createHash } from 'node:crypto'

export const normalizeLight = (text: string): string => {
  if (!text) return ''
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export const normalizeHeavy = (text: string): string => {
  if (!text) return ''
  return text
    .toLowerCase()
    .replace(/@[\w]+/g, '@_')
    .replace(/https?:\/\/[^\s]+/gi, '_URL_')
    .replace(/t\.me\/[\w+]+/gi, '_URL_')
    .replace(/\d+([.,]\d+)?/g, '_NUM_')
    .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{200D}]|[\u{20E3}]|[\u{1FA00}-\u{1FAFF}]|[\u{2300}-\u{23FF}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]|[\u{E0020}-\u{E007F}]/gu, '')
    .replace(/[$€£₴₽¥]/g, '_CUR_')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Visually confusable letters, folded to one Latin representative per class.
 *
 * Which alphabet wins is arbitrary; only consistency matters. The point is that
 * "менеджера", "меhеджера" and "менεджερа" reduce to the same string, so a
 * signature learned from one sighting matches the next rotation. Production
 * 2026-07-31: one advert reposted seven times with a different substitution
 * each time, matched by nothing, re-read by the model every time.
 *
 * Two deliberate omissions:
 *  - Digits. Folding 0→o would rewrite every price in every message, and the
 *    numeric evasions are far rarer than the letter swaps this is aimed at.
 *  - Cyrillic `и` and Latin `n`/`u`. Merging them would collide `п` with `и`,
 *    which are different letters in ordinary words rather than lookalikes.
 */
const CONFUSABLE_CLASSES: readonly (readonly [string, string])[] = [
  ['a', 'аαａàáâãäåąă'],
  ['b', 'вβƅｂ'],
  ['c', 'сϲςçćｃ'],
  ['d', 'ԁｄ'],
  ['e', 'еεєёəëèéêęｅ'],
  ['g', 'ցｇ'],
  ['h', 'нηħｈ'],
  ['i', 'іїıιíìîïｉ'],
  ['j', 'јｊ'],
  ['k', 'кκｋ'],
  ['m', 'мμｍ'],
  ['n', 'пπｎ'],
  ['o', 'оοөøóòôõöｏ'],
  ['p', 'рρｐ'],
  ['s', 'ѕşśｓ'],
  ['t', 'тτţｔ'],
  ['u', 'υｕ'],
  ['v', 'νѵｖ'],
  ['w', 'ѡωｗ'],
  ['x', 'хχ×ｘ'],
  ['y', 'уγүýÿｙ'],
  ['z', 'ᴢｚ']
]

const CONFUSABLES = new Map<string, string>()
for (const [target, members] of CONFUSABLE_CLASSES) {
  for (const member of members) CONFUSABLES.set(member, target)
}

/**
 * Replace confusable letters with their class representative, one codepoint for
 * one. Lossy by design and therefore never allowed to *decide* a match — see
 * `MongoSignaturePort.match`, which downgrades a fold-only hit to a candidate.
 */
export const foldConfusables = (text: string): string => {
  let out = ''
  for (const ch of text) out += CONFUSABLES.get(ch) ?? ch
  return out
}

/** v1 truncates sha256 hex to 32 chars — keep identical. */
export const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex').substring(0, 32)

export interface SignatureHashes {
  exactHash: string
  normalizedHash: string | null
  /**
   * Third layer, additive (2026-07-31). The two hashes above are byte-compatible
   * with v1 and must stay that way — the collection is shared — so homoglyph
   * folding could not be built into either of them without making every stored
   * signature unmatchable. It gets its own field instead.
   */
  foldedHash: string | null
}

const MIN_HEAVY_NORM_LENGTH = 5

/**
 * A folded string this short would match every other folded string of its
 * length: folding is lossy, so the shorter the text the more of it collides.
 * Same reasoning as `MIN_HEAVY_NORM_LENGTH`, a higher bar because the fold
 * discards more than the template does.
 */
const MIN_FOLDED_LENGTH = 12

/** Compute lookup hashes the same way v1 computes storage hashes. */
export const computeSignatureHashes = (text: string): SignatureHashes | null => {
  const lightNorm = normalizeLight(text)
  if (!lightNorm) return null
  const heavyNorm = normalizeHeavy(text)
  // Guard against the emoji-only collision bug (all-emoji text collapses
  // to an empty heavy norm — hashing it would match unrelated messages).
  const hasEnoughNormalized = heavyNorm.length >= MIN_HEAVY_NORM_LENGTH
  const folded = foldConfusables(lightNorm)
  return {
    exactHash: sha256(lightNorm),
    normalizedHash: hasEnoughNormalized ? sha256(heavyNorm) : null,
    foldedHash: folded.length >= MIN_FOLDED_LENGTH ? sha256(folded) : null
  }
}
