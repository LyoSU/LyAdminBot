/**
 * Writing-system analysis. Two facts the pipeline needs and had no way to get.
 *
 * 1. How much a message actually says. Every length gate here counts
 *    codepoints, which assumes one codepoint ≈ one letter. In a logographic
 *    script a codepoint is closer to a whole word, so a complete sentence
 *    measures shorter than a greeting and the abstain gate calls it
 *    uninformative (2026-07-31: a ten-character advert scored `observe` and was
 *    never classified at all).
 *
 * 2. Whether the message is written in a script this chat uses. That matters
 *    because every heuristic stage below — custom rules, signatures, vectors,
 *    moderation — is calibrated on the chat's own language. Against an alien
 *    script they are all blind, and their silence is not evidence of innocence:
 *    the LLM is the only multilingual reader in the pipeline.
 */
import type { NormalizedChat } from '../types.js'

export type ScriptName =
  | 'latin' | 'cyrillic' | 'greek' | 'armenian' | 'georgian'
  | 'han' | 'kana' | 'hangul'
  | 'arabic' | 'hebrew' | 'thai' | 'devanagari'

/**
 * Ordered so the cheapest and commonest tests run first; each character is
 * classified by the first script that claims it.
 */
const SCRIPTS: readonly (readonly [ScriptName, RegExp])[] = [
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['han', /\p{Script=Han}/u],
  ['kana', /\p{Script=Hiragana}|\p{Script=Katakana}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['greek', /\p{Script=Greek}/u],
  ['thai', /\p{Script=Thai}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['armenian', /\p{Script=Armenian}/u],
  ['georgian', /\p{Script=Georgian}/u]
]

/**
 * Content carried by one character, relative to an alphabetic letter.
 *
 * A Han character is a morpheme — roughly a short word — so three is the
 * conservative end of the range. Kana and Hangul are syllabic: denser than a
 * letter, lighter than a word. Chosen so that a two- or three-character
 * courtesy ("thank you", "hello") stays below every gate while a full sentence
 * clears them, which is exactly the distinction the gates are asking about.
 */
const SCRIPT_DENSITY: Partial<Record<ScriptName, number>> = {
  han: 3,
  kana: 2,
  hangul: 2
}

const scriptOf = (ch: string): ScriptName | null => {
  for (const [name, re] of SCRIPTS) if (re.test(ch)) return name
  return null
}

/**
 * Alphabets drawn alike, so that a letter of one can stand in for a letter of
 * another. These three are the whole basis of every homoglyph table (UTS#39
 * singles out the same trio), and `CONFUSABLE_CLASSES` in the signature layer
 * folds exactly them.
 *
 * A fixed set, deliberately, rather than "the word uses more than one script":
 * Japanese and Korean mix scripts inside a word and put no spaces between
 * words, so counting scripts would charge every message written in them for
 * evasion — and those are precisely the messages the rest of the pipeline is
 * least able to read.
 */
const CONFUSABLE_SCRIPTS: readonly ScriptName[] = ['latin', 'cyrillic', 'greek']

/**
 * Whether one word borrows letters from two look-alike alphabets. Character
 * classes cannot express this: the check used to be `[Ѐ-ӿ]` against `[a-zA-Z]`,
 * which saw only Latin donors (production 2026-07-31: an advert substituting
 * Greek omicron, kappa and rho raised nothing at all) and missed every donor
 * outside those two ranges besides — Cyrillic Supplement, fullwidth and
 * extended Latin all sit past their ends.
 */
export const mixesConfusableScripts = (word: string): boolean => {
  const seen = new Set<ScriptName>()
  for (const ch of word) {
    const script = scriptOf(ch)
    if (script === null || !CONFUSABLE_SCRIPTS.includes(script)) continue
    seen.add(script)
    if (seen.size > 1) return true
  }
  return false
}

/**
 * Prose only: handles and URLs are addressing and machinery, never a statement
 * about the language a message is written in. Both are Latin by construction
 * (Telegram usernames are ASCII), so counting them let six letters of a handle
 * outvote eight Han characters and the message read as Latin.
 */
const prose = (text: string): string => text
  .replace(/https?:\/\/\S+|\b(?:www\.|t\.me\/)\S+/gi, ' ')
  .replace(/@\w+/g, ' ')

/** Letters per script, ignoring digits, punctuation, emoji and whitespace. */
const scriptCounts = (raw: string): Map<ScriptName, number> => {
  const counts = new Map<ScriptName, number>()
  for (const ch of prose(raw)) {
    const script = scriptOf(ch)
    if (script === null) continue
    counts.set(script, (counts.get(script) ?? 0) + 1)
  }
  return counts
}

/** A script must hold more than half the letters to name the text. */
const DOMINANCE_MIN_SHARE = 0.5

/**
 * The script this text is written in, or null when the letters do not agree —
 * genuinely bilingual text names no single language, and neither should we.
 */
export const dominantScript = (text: string): ScriptName | null => {
  const counts = scriptCounts(text)
  let total = 0
  for (const n of counts.values()) total += n
  if (total === 0) return null

  for (const [script, n] of counts) {
    if (n / total > DOMINANCE_MIN_SHARE) return script
  }
  return null
}

/**
 * Length of `text` in units of content rather than codepoints. Non-letters
 * count one apiece, as before — only the scripts where a codepoint means more
 * than a letter are weighted up.
 */
export const informativeLength = (text: string): number => {
  let total = 0
  for (const ch of text) {
    const script = scriptOf(ch)
    total += script === null ? 1 : SCRIPT_DENSITY[script] ?? 1
  }
  return total
}

/**
 * Scripts of the locales the bot ships a UI for. These are tolerated in every
 * chat unconditionally: a Latin word inside Cyrillic text (a brand, a URL, a
 * code snippet) is ordinary everywhere, and treating it as foreign would fire
 * on most legitimate messages rather than on the rare alien one.
 */
const SHIPPED_SCRIPTS: readonly ScriptName[] = ['latin', 'cyrillic']

const LOCALE_SCRIPTS: Record<string, ScriptName[]> = {
  uk: ['cyrillic'], ru: ['cyrillic'], by: ['cyrillic'], en: ['latin'], tr: ['latin']
}

/**
 * Content a sample must carry before it may teach us a script. Measured in the
 * same weighted units as `informativeLength`, not in codepoints — a bar counted
 * in characters would demand several times more text of a logographic chat than
 * of an alphabetic one, i.e. exactly the mistake this module exists to correct.
 */
const SAMPLE_MIN_CONTENT = 24

const weightedTotal = (counts: Map<ScriptName, number>): number => {
  let total = 0
  for (const [script, n] of counts) total += n * (SCRIPT_DENSITY[script] ?? 1)
  return total
}

export interface ChatScriptSource {
  topLanguage: string | null
  title: string
  /**
   * The chat's own description. A far better language sample than the title:
   * admin-authored, and long enough to clear `SAMPLE_MIN_CONTENT`, which a
   * two-word title almost never does.
   */
  description?: string | null
}

/**
 * Scripts this chat demonstrably uses.
 *
 * A union of every source, never an intersection: each one may only *add*
 * tolerance. A chat with an English name whose members write Cyrillic must not
 * have Cyrillic taken away from it by its title, so no source is allowed to
 * veto another. The consequence is that the profile errs toward firing less.
 *
 * `SAMPLE_MIN_LETTERS` keeps a single stray line from teaching the wrong
 * lesson — one forwarded quote is not the chat's language.
 */
export const chatScriptProfile = (
  chat: ChatScriptSource,
  window: { textPreview: string | null }[]
): Set<ScriptName> => {
  const profile = new Set<ScriptName>(SHIPPED_SCRIPTS)

  for (const script of LOCALE_SCRIPTS[chat.topLanguage ?? ''] ?? []) profile.add(script)

  const learnFrom = (sample: string): void => {
    const counts = scriptCounts(sample)
    if (weightedTotal(counts) < SAMPLE_MIN_CONTENT) return
    let total = 0
    for (const n of counts.values()) total += n
    for (const [script, n] of counts) {
      // Same dominance bar as a single message: a script has to carry real
      // weight in the sample, not merely appear in it.
      if (n / total > DOMINANCE_MIN_SHARE) profile.add(script)
    }
  }

  learnFrom(window.map((l) => l.textPreview ?? '').join(' '))
  learnFrom(chat.title)
  learnFrom(chat.description ?? '')

  return profile
}

/**
 * Whether the message is written in a script this chat does not use — the
 * condition under which every heuristic stage below is blind and only the LLM
 * can read what was written.
 */
export const isForeignScript = (
  text: string,
  chat: NormalizedChat,
  window: { textPreview: string | null }[]
): ScriptName | null => {
  const script = dominantScript(text)
  if (script === null) return null
  return chatScriptProfile(chat, window).has(script) ? null : script
}
