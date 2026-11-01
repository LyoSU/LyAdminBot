/**
 * What a join looks like, written down so a later question can be asked of it.
 *
 * Until 2026-09-27 a join left no trace that outlived the process: the arrival
 * log is in memory and nothing was logged for a chat without a greeting. So
 * "this account was removed in one chat — which others is it sitting in?" and
 * "who came into this chat beside it?" had no answer, and over the 14 days to
 * that date 25.6 % of external-listing removals were an account already
 * removed elsewhere, p50 six minutes earlier.
 *
 * The shape is what comes free with the join — no profile request — and is
 * recorded as facts, never as the name.
 */
import { dominantScript, IMITABLE_REASON_CODES } from '@lyadmin/core'
import { predictRegistrationUnix } from '@lyadmin/adapters'
import type { ArrivalShape } from '@lyadmin/data'

/** The parts of mtcute's `User` a shape is read from. */
export interface JoinerFacts {
  id: number
  displayName: string
  username: string | null
  lastName: string | null
  hasPhoto: boolean
  isPremium: boolean
}

export const arrivalShapeOf = (joiner: JoinerFacts, nowUnix = Math.floor(Date.now() / 1000)): ArrivalShape => ({
  username: typeof joiner.username === 'string' && joiner.username.length > 0,
  photo: joiner.hasPhoto,
  lastName: typeof joiner.lastName === 'string' && joiner.lastName.trim().length > 0,
  premium: joiner.isPremium,
  script: dominantScript(String(joiner.displayName ?? '')),
  registeredUnix: predictRegistrationUnix(joiner.id, nowUnix)
})

/**
 * Outcomes after which an arrival is settled: the account has already been
 * taken from that chat, so there is nothing left to carry over to it.
 */
export const REMOVED_ARRIVAL_OUTCOMES: ReadonlySet<string> = new Set([
  'removed', 'banned_on_record', 'banned_carried', 'banned_by_admin'
])

/**
 * At most this many chats per account. The measured worst spree touched nine
 * chats in a fortnight; ten keeps one account from turning into a burst of
 * bans and notices across the network.
 */
export const RECORD_BAN_CHATS_MAX = 10

/**
 * The other chats an account was removed from one chat for, on its record.
 *
 * Only chats it was SEEN joining this week — the one membership the bot knows
 * without asking Telegram about every chat it sits in, which at the observed
 * removal rate would cost tens of thousands of requests a day. Newest first,
 * because the most recent join is the one most likely to be about to post.
 */
export const recordBanTargets = (
  arrivals: readonly { chatId: number; at: Date; outcome: string | null }[],
  fromChatId: number,
  max = RECORD_BAN_CHATS_MAX
): number[] => {
  const seen = new Set<number>()
  const out: number[] = []
  for (const a of [...arrivals].sort((x, y) => y.at.getTime() - x.at.getTime())) {
    if (a.chatId === fromChatId || seen.has(a.chatId)) continue
    seen.add(a.chatId)
    if (a.outcome !== null && REMOVED_ARRIVAL_OUTCOMES.has(a.outcome)) continue
    out.push(a.chatId)
    if (out.length >= max) break
  }
  return out
}

/**
 * Stages whose act is a finding about a MESSAGE. A removal on the account's
 * record (`deterministic` listings, `join_screen`) is not in this set: it
 * already carries.
 */
const CONTENT_DECIDERS: ReadonlySet<string> = new Set([
  'signature', 'llm', 'llm_cached', 'session', 'score', 'burst'
])

/**
 * Whether an act would be a candidate for carrying to the chats the account
 * sits silent in, if content bans were ever carried. Used only to measure that
 * (2026-10-02, shadow): a hijacked account posts spam once, so the verdict on
 * the message can be right while the conclusion about the account is wrong —
 * the reason content bans were not carried. Still stamped for every act it
 * takes, so the deletes and mutes `isContentCarryAct` leaves out keep being
 * measured.
 */
export const isShadowCarryAct = (
  act: { decidedBy: string; action: string; messageId: number; applied: boolean }
): boolean =>
  act.applied
  && act.messageId > 0
  && CONTENT_DECIDERS.has(act.decidedBy)
  && (act.action === 'ban' || act.action === 'delete' || act.action === 'mute')

/**
 * Whether a content act is carried, as a ban, to the chats the account joined
 * this week and has not been removed from — no longer only measured.
 *
 * Shadow, 2026-10-02 to 2026-10-14: 346 arrival rows stamped. Every row whose
 * account went on to post in the target chat — 107 of them — was then punished
 * there by the pipeline itself; none came out clean. None of the source acts
 * was overridden, and none of the accounts had ever been an established
 * regular. The stamp landed p50 18 minutes after the join and the next post p50
 * 2 minutes after the stamp, so carrying is the difference between the advert
 * being seen and not.
 *
 * Narrower than the shadow on purpose: a `ban` alone, the act the pipeline
 * already took against the ACCOUNT in the source chat. Over the 30 days to the
 * same date people reversed 51 content acts, one of them a ban; a `delete` says
 * "this message" and stays a finding about it. `needsVote` is the chat still
 * being asked, so nothing is concluded yet.
 */
export const isContentCarryAct = (
  act: { decidedBy: string; action: string; messageId: number; applied: boolean; needsVote: boolean }
): boolean => isShadowCarryAct(act) && act.action === 'ban' && !act.needsVote

/**
 * Reason codes whose spam vote is a conclusion about the ACCOUNT, and so is
 * carried as a ban to the chats it sits silent in.
 *
 * Vote outcomes by the verdict's reason code, spam:ham, over the 30 days to
 * 2026-10-31 (resolved votes): job_scam 422:5, shared_profile_photo 230:5,
 * adult_promo 45:5, guest_bot_promo 30:2, crypto_scam 26:3 — a ham share of
 * 1–10 %, and what they name (a recruiter, a photo shared by a farm, an escort
 * ad) is not something a member does by accident. The codes left out are the
 * ones the same measure puts at 20–27 % ham: other_spam 176:48, channel_promo
 * 69:21, flirt_bait 56:12, flood 39:14 — a verdict on a message, where the
 * account may just have had a bad minute. `ad_network` (27:1) is excluded for
 * the other reason: it is imitable (`IMITABLE_REASON_CODES`), an act members
 * also perform, and the pipeline's own ceiling already treats it as one. Codes
 * with no measurement (phishing, gambling_promo, prompt_injection) stay out
 * until they have one.
 */
export const VOTE_CARRY_REASON_CODES: ReadonlySet<string> = new Set([
  'job_scam', 'shared_profile_photo', 'adult_promo', 'guest_bot_promo', 'crypto_scam'
])

/**
 * Whether a resolved vote is carried, as a ban, to the chats the account joined
 * this week and has not been removed from.
 *
 * Production 2026-10-31: one account with a profile photo shared by eight
 * others and an invite link in its bio posted in several of our chats; each
 * muted it and opened a vote, and admins confirmed spam in one chat and then
 * again, for the same account, in the next — a person's confirmation was not
 * reused anywhere else.
 *
 * Only a settled spam ruling that silenced the ACCOUNT: `accountRemoved` is
 * what the enforcement reported (the mute landed), not that the message went —
 * a delete alone is a finding about the message. An expiry never gets here by
 * `decidedBy: null`: nobody ruled, and `expiryOutcome` already refuses to treat
 * a tally below the quorum as a verdict.
 */
export const isVoteCarryResolution = (r: {
  outcome: string
  decidedBy: string | null
  reasonCode: string | null
  accountRemoved: boolean
}): boolean =>
  r.outcome === 'spam'
  && (r.decidedBy === 'quorum' || r.decidedBy === 'admin')
  && r.accountRemoved
  && r.reasonCode !== null
  && VOTE_CARRY_REASON_CODES.has(r.reasonCode)
  && !IMITABLE_REASON_CODES.has(r.reasonCode)

/**
 * An account seen joining this many of our chats inside this window is
 * marked, in shadow, on the arrival that crossed the line.
 *
 * Measured over the 7 days of arrivals to 2026-10-14, by the most distinct
 * chats an account joined inside any 6 hours: one chat, 29.6 % later punished
 * (66 ever regulars); two, 67 % (1); three or four, 76 %; five or more, 90 % —
 * and of the 82 accounts at three or more, none was ever a regular and none
 * posted three clean messages anywhere. 17 of the 68 punished were caught
 * before the third join; the rest were not, and the first post-deploy farm the
 * same day sat in nine chats with one message between them.
 */
export const MULTI_JOIN_WINDOW_MS = 6 * 3_600_000
export const MULTI_JOIN_MIN_CHATS = 3

/** Distinct chats among `arrivals` joined at or after `now - windowMs`. */
export const chatsJoinedWithin = (
  arrivals: readonly { chatId: number; at: Date }[],
  now: number,
  windowMs = MULTI_JOIN_WINDOW_MS
): number => new Set(arrivals.filter((a) => now - a.at.getTime() <= windowMs).map((a) => a.chatId)).size

/**
 * Arrivals this close to a confirmed spammer's, either side, count as having
 * come in with it. The screenshot that started this (2026-09-27) showed one
 * batch trickling in over two days; the arrivals themselves last a week.
 */
export const COHORT_WINDOW_MS = 72 * 60 * 60 * 1000
/**
 * Registration dates this close count as one batch. The id-based prediction
 * is itself a window of weeks, so this cannot be narrower than that.
 */
export const COHORT_REGISTRATION_TOLERANCE_DAYS = 60
/** At most this many on one card: past it the chat is being raided, which the surge alert covers. */
export const COHORT_MAX = 10

/**
 * Whether two arrivals look like one batch.
 *
 * Every free fact must agree, and two of them must be KNOWN to agree: a
 * name with no dominant script, or an id that predicts no registration, is
 * missing evidence, and "both missing" is not a match — that is how a
 * chat's ordinary newcomers, who vary, would end up in one cohort.
 */
export const sameShape = (
  a: ArrivalShape, b: ArrivalShape, toleranceDays = COHORT_REGISTRATION_TOLERANCE_DAYS
): boolean =>
  a.username === b.username &&
  a.photo === b.photo &&
  a.lastName === b.lastName &&
  a.premium === b.premium &&
  a.script !== null && a.script === b.script &&
  a.registeredUnix !== null && b.registeredUnix !== null &&
  Math.abs(a.registeredUnix - b.registeredUnix) <= toleranceDays * 86400

export interface CohortArrival {
  userId: number
  at: Date
  shape: ArrivalShape
  messagesGlobalAtJoin: number | null
  outcome: string | null
}

/**
 * Whether the bot bans a confirmed spammer's silent look-alikes itself, with
 * an undo, instead of asking the admins first. Flip to `false` to bring back
 * the card ("N similar newcomers — ban / keep") with nothing else changed.
 *
 * Until 2026-10-31 this was a card, on the reasoning that they had done
 * nothing and resembling a spammer is a reason to ask. A read-only replay of
 * the 7 days of arrivals: 784 newcomers matched as siblings of 1108
 * bot-removed accounts; 559 (71 %) were later punished by the pipeline itself
 * anyway, 15 posted any clean message (14 one or two, 1 three or more) and
 * none ever became an established regular. Since 2026-10-23 admins banned 165
 * of them from the card and reversed none, and every answered card in a 5
 * hour sample was "ban all" — the card cost an admin a tap for an answer that
 * never varied, and the wait is when the batch posts its advert.
 */
export const COHORT_AUTO_BAN = true

/**
 * Splits a cohort by whether Telegram already deleted the account. A deleted
 * account cannot post; it is removed without being named on anything. An
 * account whose profile could not be read stays with the live ones.
 */
export const splitDeleted = (
  members: readonly { userId: number; deleted: boolean }[]
): { deleted: number[]; live: number[] } => ({
  deleted: members.filter((m) => m.deleted).map((m) => m.userId),
  live: members.filter((m) => !m.deleted).map((m) => m.userId)
})

/**
 * The newcomers who came into a chat beside an account now confirmed as a
 * spammer and look like it — the candidates `surfaceCohort` bans (see
 * `COHORT_AUTO_BAN` for the measurement), or puts on a card when that is off.
 * Resembling a spammer is not a finding about the account, so the ban is
 * undoable, and an admin's undo (outcome `restored`) takes the account out of
 * every later cohort.
 *
 * Only arrivals the bot had never seen speak anywhere, and not already taken
 * from the chat. Whether they have spoken HERE since is the caller's to check,
 * because the arrival row does not know. Nearest in time first.
 */
export const cohortSiblings = <T extends CohortArrival>(
  spammer: CohortArrival,
  arrivals: readonly T[],
  options: { windowMs?: number; max?: number } = {}
): T[] => {
  const windowMs = options.windowMs ?? COHORT_WINDOW_MS
  const max = options.max ?? COHORT_MAX
  const t = spammer.at.getTime()
  return arrivals
    .filter((a) =>
      a.userId !== spammer.userId &&
      Math.abs(a.at.getTime() - t) <= windowMs &&
      (a.messagesGlobalAtJoin ?? 0) === 0 &&
      (a.outcome === null || (!REMOVED_ARRIVAL_OUTCOMES.has(a.outcome) && a.outcome !== 'restored')) &&
      sameShape(a.shape, spammer.shape))
    .sort((x, y) => Math.abs(x.at.getTime() - t) - Math.abs(y.at.getTime() - t))
    .slice(0, max)
}
