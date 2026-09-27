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
