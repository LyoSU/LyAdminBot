/**
 * When may the bot learn a spam signature from its OWN verdict, with no human
 * in the loop?
 *
 * Background (2026-07-27 production review): the signature and vector stores
 * only ever learned from `enforceVoteSpam` — i.e. after a community vote.
 * Hundreds of automatic enforcements a day taught them nothing, and the cost
 * was visible in the logs: identical spam texts were re-sent to the LLM for
 * classification dozens of times across chats, because no signature was ever
 * written for them.
 *
 * Getting this wrong in the other direction is far worse than wasted calls: a
 * poisoned store silently deletes innocent messages, indefinitely, with no
 * human ever being asked. So the rule is narrow, and it is a pure function so
 * the reasoning stays testable.
 */
import type { DecidedBy, Verdict } from './types.js'

/**
 * Stages whose verdict rests on the MESSAGE, not on who sent it.
 *
 * `score` is excluded: it is the account-shape path, the exact false-positive
 * class this review was about.
 *
 * `deterministic` is the subtle exclusion. Its highest-volume rule condemns
 * the ACCOUNT (an external ban listing), not what the account wrote — and
 * listed accounts spend most of their messages posting ordinary conversational
 * filler to look human. Learning from that path would fill the store with
 * everyday sentences and then match them against real people.
 */
export const AUTO_LEARN_DECIDED_BY = new Set<DecidedBy>([
  'llm',        // the model actually read the text
  'llm_cached', // same verdict, served from cache
  'velocity',   // the same text blasted across chats is spam by construction
  'custom_rule' // an admin wrote the pattern themselves
])

/** Only near-certain verdicts. */
export const AUTO_LEARN_MIN_PSPAM = 0.95

/**
 * Below this a text is not distinctive enough to be a signature. Enforcement
 * regularly lands on one-word messages and bare emoji; turning those into
 * match patterns would be indiscriminate.
 */
export const AUTO_LEARN_MIN_LENGTH = 40

export const shouldAutoLearn = (verdict: Verdict, text: string): boolean => {
  if (!AUTO_LEARN_DECIDED_BY.has(verdict.decidedBy)) return false
  if (!Number.isFinite(verdict.pSpam) || verdict.pSpam < AUTO_LEARN_MIN_PSPAM) return false
  return text.trim().length >= AUTO_LEARN_MIN_LENGTH
}

/** Provenance string stored with the learned text, for later auditing. */
export const autoLearnSource = (verdict: Verdict): string =>
  `auto:${verdict.decidedBy}:${verdict.reasonCode}`
