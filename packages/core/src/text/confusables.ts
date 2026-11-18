/**
 * Moved from `packages/data/src/hashing.ts` (2026-11-18) so that core can fold
 * too — chat stop-words match through it. The data layer re-exports it; the
 * signature hashes it feeds are unchanged byte for byte.
 */
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
