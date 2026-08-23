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
 * What a resolved community vote may teach: a candidate, never more.
 *
 * It used to be able to ask for `confirmed` once three ballots agreed, and a
 * confirmed signature is a short circuit — `pSpam 0.96`, no LLM, no evidence
 * bar, in all 52 chats for ninety days. The distinctiveness bar was supposed to
 * be the guard, but it measures length and nothing else, so on 2026-08-23 a
 * 45-character remark from one argument became a global deciding rule after a
 * 3:0 vote. `/report` opens a question about ANY message, which makes that path
 * available to any three members who want it.
 *
 * So the vote no longer mints deciding rules at all. It files a candidate, and
 * promotion is left to the mechanism that was already the honest one: the SAME
 * text reported from a SECOND, independent chat (`CORROBORATING_CHATS_MIN` in
 * the signature port). One chat can be wrong, or captured; two rarely are.
 *
 * The cost is deliberate and worth naming: a campaign hitting a single chat is
 * now caught a beat slower, because its first sighting only raises a signal.
 * Note this constrains the VOTE, not the threat feed — an external source
 * (CAS) still writes confirmed on its own authority, which is a different
 * claim from a different place.
 */
export const VOTE_LEARN_STATUS = 'candidate' as const

export const shouldAutoLearn = (verdict: Verdict, text: string): boolean => {
  if (!AUTO_LEARN_DECIDED_BY.has(verdict.decidedBy)) return false
  if (!Number.isFinite(verdict.pSpam) || verdict.pSpam < AUTO_LEARN_MIN_PSPAM) return false
  return text.trim().length >= AUTO_LEARN_MIN_LENGTH
}

/** Provenance string stored with the learned text, for later auditing. */
export const autoLearnSource = (verdict: Verdict): string =>
  `auto:${verdict.decidedBy}:${verdict.reasonCode}`
