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
