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
 * The representative does NOT have to be Latin (2026-07-31). It used to be,
 * silently, and the cost was that a pair with no Latin lookalike could not be
 * expressed at all: `л`/`λ` and `ф`/`φ` were invisible to the fold, and a
 * production rotation escaped through `Λ` five minutes after its predecessor was
 * matched.
 *
 * Digits fold too, which the first version refused on the grounds that "0→o
 * rewrites every price". That objection does not survive contact with what the
 * fold is for: the distortion is applied to both sides of every comparison, so
 * rewriting is free, and since distinct digits fold to distinct letters two
 * different numbers can never become equal. What collapses is exactly
 * digit-for-letter evasion (`4ат`), which is what we keep seeing.
 *
 * Included are only the digits with ONE obvious letter. `1`, `5` and `6` are
 * left out because their shape fits several letters (`1`→i/l/і, `6`→б/b), and a
 * fold that guesses wrong merges unrelated words instead of catching evasion.
 *
 * `и` folds to `u`, which an earlier version refused: "merging them would collide
 * `п` with `и`". That reason was about `n` and over-reached to `u` as well —
 * `п` folds to `n` and `и` to `u`, so the two stay apart, and the collision the
 * objection warned about cannot occur. It matters because Latin `u` for `и` is
 * one of the commonest substitutions there is.
 *
 * Still omitted: letters with no cross-script twin in actual use. A class for
 * them would buy nothing and only widen the collision surface.
 *
 * A LIMIT worth stating plainly. This table is data for a problem that is
 * genuinely table-shaped, but it is a hand-built subset of UTS#39, so it is
 * complete only up to the last attack somebody looked at. Two measurements from
 * 2026-07-31 rule out the shortcuts: `NFKD` decomposes none of the letters used
 * in these attacks (`ɯ ʍ ʙ ᴇ ҡ σ δ ∂` all decompose to themselves), and folding
 * before EMBEDDING is worse than useless, since the fold mangles ordinary
 * Cyrillic into mixed script and the embedding of that is noise. The complete
 * answer is the Unicode confusables data itself, vendored or depended upon —
 * a decision this file cannot make.
 */
const CONFUSABLE_CLASSES: readonly (readonly [string, string])[] = [
  ['a', 'аαａàáâãäåąă'],
  ['b', 'вβƅｂʙ'],
  ['c', 'сϲςçćｃ'],
  ['d', 'ԁｄ'],
  ['e', 'еεєёəëèéêęｅᴇ'],
  ['g', 'ցｇ'],
  ['h', 'нηħｈ'],
  ['i', 'іїıιíìîïｉ'],
  ['j', 'јｊ'],
  ['k', 'кκｋҡ'],
  ['m', 'мμｍʍ'],
  ['n', 'пπｎ'],
  ['o', 'оοөøóòôõöｏ0σ'],
  ['p', 'рρｐ'],
  ['s', 'ѕşśｓ'],
  ['t', 'тτţｔ'],
  ['u', 'υｕи'],
  ['v', 'νѵｖ'],
  ['w', 'ѡωｗ'],
  ['x', 'хχ×ｘ'],
  ['y', 'уγүýÿｙ'],
  ['z', 'ᴢｚ'],
  // Cyrillic representatives: these letters have no Latin lookalike, so a
  // Latin-only target alphabet could not express them at all.
  ['л', 'λ'],
  ['ш', 'ɯ'],
  ['б', 'δ'],
  ['д', '∂'],
  ['ф', 'φ'],
  // Digit-for-letter, one unambiguous shape each.
  ['ч', '4'],
  ['з', '3']
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
