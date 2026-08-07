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
/*
 * `velocity` was here on the reasoning that the same text blasted across chats
 * is spam by construction. It is gone with the decider itself (2026-08-07): a
 * cross-post is what a member sharing a link looks like too, and this list only
 * ever sees `decidedBy`, so it cannot tell the two apart. Nothing replaces the
 * entry — repetition now reaches the classifier as a signal, and if the
 * classifier condemns the text it teaches through `llm` on its own merits.
 */
export const AUTO_LEARN_DECIDED_BY = new Set<DecidedBy>([
  'llm',        // the model actually read the text
  'llm_cached', // same verdict, served from cache
  'custom_rule' // an admin wrote the pattern themselves
])

/** Only near-certain verdicts. */
export const AUTO_LEARN_MIN_PSPAM = 0.95

/**
 * Below this a text is not distinctive enough to become a match rule of ANY
 * kind — signature, vector, or auto-learn. Enforcement regularly lands on
 * one-word messages and bare emoji; turning those into match patterns would be
 * indiscriminate.
 *
 * Shared with the vector layer on purpose (2026-07-30 review): embedding
 * similarity on short strings is dominated by length and topic, so two
 * unrelated greetings routinely sit above 0.93 cosine. The signature layer
 * learned this the hard way in v1, where a two-word morning greeting earned
 * people auto-bans; the vector layer had no equivalent guard at all.
 */
export const MIN_DISTINCTIVE_LENGTH = 40

/** Historical alias — the auto-learn bar is the distinctiveness bar. */
export const AUTO_LEARN_MIN_LENGTH = MIN_DISTINCTIVE_LENGTH

/** A text long enough that a match against it means something. */
export const isDistinctive = (text: string): boolean =>
  text.trim().length >= MIN_DISTINCTIVE_LENGTH

/**
 * Net spam ballots required before a vote may write a *deciding* rule.
 *
 * `tallyVotes` resolves instantly on a single admin ballot — correct for
 * acting on THIS message, wrong as a basis for a permanent cross-chat rule.
 * One admin tapping "spam" used to write a confirmed signature (90d) and a
 * confirmed vector (no expiry at all) that then auto-enforced in every chat
 * the bot watches, with no way back except editing the database by hand.
 * Acting locally needs one human; teaching all 52 chats needs agreement.
 */
export const VOTE_CONFIRM_MIN_BALLOTS = 2

/**
 * How strongly a spam-resolved vote may teach the stores. A `candidate` still
 * raises a signal on the next occurrence (and the stores promote it themselves
 * once a second, independent chat reports the same text) — it just may not
 * convict on its own.
 */
export const voteLearnStatus = (
  tally: { spam: number; ham: number }
): 'candidate' | 'confirmed' =>
  tally.spam >= VOTE_CONFIRM_MIN_BALLOTS && tally.spam > tally.ham
    ? 'confirmed'
    : 'candidate'

export const shouldAutoLearn = (verdict: Verdict, text: string): boolean => {
  if (!AUTO_LEARN_DECIDED_BY.has(verdict.decidedBy)) return false
  if (!Number.isFinite(verdict.pSpam) || verdict.pSpam < AUTO_LEARN_MIN_PSPAM) return false
  return text.trim().length >= AUTO_LEARN_MIN_LENGTH
}

/** Provenance string stored with the learned text, for later auditing. */
export const autoLearnSource = (verdict: Verdict): string =>
  `auto:${verdict.decidedBy}:${verdict.reasonCode}`
