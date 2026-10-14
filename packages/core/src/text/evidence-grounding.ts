/**
 * Whether the classifier's `evidence` is actually in the text it judged.
 *
 * The prompt asks for "a short quote from the message that motivated the
 * verdict". A quote that is in the message points at something a reader can
 * check; one that is not was written by the model, and a verdict resting on a
 * sentence nobody sent is the shape of the vague-category false positive.
 * Measured over the 14 days to 2026-10-14: `other_spam` deletes were reversed
 * by people at 4.4 %, `job_scam` at 0 of 765.
 *
 * Shadow only. Nothing reads the answer but the decision row, so whether an
 * ungrounded verdict should lose its removal can be priced on production
 * first. Deterministic and cheap: no second model call, no prompt change.
 */
import { stripEmoji, stripInvisible } from './normalize.js'

export type EvidenceGrounding =
  /** Every segment of the quote is in the text, after normalisation. */
  | 'quoted'
  /** Not verbatim, but most of its words are in the text. */
  | 'paraphrased'
  /** The words are mostly not in the text at all. */
  | 'absent'
  /** The model gave no evidence. */
  | 'missing'
  /** There was no text to quote from — a picture, a sticker. */
  | 'no_text'

/** Share of the quote's words that must appear in the text to be a paraphrase. */
const PARAPHRASE_MIN_SHARE = 0.6
/** Segments shorter than this are joins and punctuation, not quoted content. */
const MIN_SEGMENT = 3

/**
 * Case, compatibility forms, invisibles, emoji, quote marks and whitespace are
 * all things a model rewrites while quoting faithfully, so none of them may
 * decide the answer.
 */
const fold = (s: string): string =>
  stripEmoji(stripInvisible(s.normalize('NFKC')))
    .toLowerCase()
    .replace(/[«»"“”„'‘’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const words = (s: string): string[] =>
  s.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= MIN_SEGMENT)

export const evidenceGrounding = (evidence: string | null | undefined, text: string): EvidenceGrounding => {
  if (typeof evidence !== 'string' || fold(evidence) === '') return 'missing'
  const body = fold(text)
  if (body === '') return 'no_text'
  // A model shortens a long quote with an ellipsis; each piece is a quote.
  const segments = fold(evidence).split(/\s*(?:…|\.\.\.)\s*/).filter((s) => s.length >= MIN_SEGMENT)
  if (segments.length > 0 && segments.every((s) => body.includes(s))) return 'quoted'
  const quoteWords = words(fold(evidence))
  if (quoteWords.length === 0) return 'absent'
  const bodyWords = new Set(words(body))
  const found = quoteWords.filter((w) => bodyWords.has(w)).length
  return found / quoteWords.length >= PARAPHRASE_MIN_SHARE ? 'paraphrased' : 'absent'
}
