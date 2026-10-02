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
import { dominantScript } from '@lyadmin/core'
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
  'removed', 'banned_on_record', 'banned_by_admin'
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
 * the reason content bans are not carried today.
 */
export const isShadowCarryAct = (
  act: { decidedBy: string; action: string; messageId: number; applied: boolean }
): boolean =>
  act.applied
  && act.messageId > 0
  && CONTENT_DECIDERS.has(act.decidedBy)
  && (act.action === 'ban' || act.action === 'delete' || act.action === 'mute')

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
 * The newcomers who came into a chat beside an account now confirmed as a
 * spammer and look like it — candidates for an admin to look at, never for the
 * bot to remove. The spammer was confirmed on what IT did; they have done
 * nothing, and resembling it is a reason to ask, not a finding.
 *
 * Only arrivals the bot had never seen speak anywhere, and not already taken
 * from the chat. Whether they have spoken HERE since is the caller's to check,
 * because the arrival row does not know. Nearest in time first.
 */
export const cohortSiblings = (
  spammer: CohortArrival,
  arrivals: readonly CohortArrival[],
  options: { windowMs?: number; max?: number } = {}
): CohortArrival[] => {
  const windowMs = options.windowMs ?? COHORT_WINDOW_MS
  const max = options.max ?? COHORT_MAX
  const t = spammer.at.getTime()
  return arrivals
    .filter((a) =>
      a.userId !== spammer.userId &&
      Math.abs(a.at.getTime() - t) <= windowMs &&
      (a.messagesGlobalAtJoin ?? 0) === 0 &&
      (a.outcome === null || !REMOVED_ARRIVAL_OUTCOMES.has(a.outcome)) &&
      sameShape(a.shape, spammer.shape))
    .sort((x, y) => Math.abs(x.at.getTime() - t) - Math.abs(y.at.getTime() - t))
    .slice(0, max)
}
