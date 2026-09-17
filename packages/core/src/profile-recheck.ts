/**
 * A second look at a profile that was bare when its owner first wrote.
 *
 * The pipeline reads a profile once, when the message arrives, and the profile
 * cache then holds that reading for a day. Measured over the 14 days to
 * 2026-09-17: of the accounts people reported by hand, some had commented with
 * no picture at all — nothing for any stage to find — and were seen 20 to 233
 * minutes later, by the report screen, wearing a picture shared with fourteen
 * other accounts. The comment was already in the chat; the advert arrived
 * under it afterwards.
 *
 * How often that happens is NOT known, and cannot be read out of what is
 * stored: 2848 newcomers wrote with no picture in that fortnight, 64 were seen
 * again with one, and 2784 were simply never looked at twice. 12 of the 64 had
 * taken the farm's shape, 11 of them visible only because somebody reported
 * them. So this measures and does nothing else — a second look whose whole
 * output is a row. Whether it is worth a hold and a timer that survives a
 * restart is what a week of those rows is for.
 */
import { isFarmShapedProfile } from './pipeline.js'
import type { Signal, VerdictAction } from './types.js'

/**
 * Both measured from the message. The observed lag to the picture ran p25 12,
 * p50 24, p75 98 minutes — on a sample censored toward the short end, since a
 * report is what produced most second sightings and reports come early.
 */
export const PROFILE_RECHECK_DELAYS_MS: readonly number[] = [30 * 60 * 1000, 3 * 60 * 60 * 1000]
/** About two days of the measured rate (~200 a day), so only a raid reaches it. */
export const PROFILE_RECHECK_MAX_PENDING = 500

export const wantsProfileRecheck = (facts: {
  isUser: boolean
  newish: boolean
  /** Null when the photo lookup did not answer — which is not "no picture". */
  avatarCount: number | null
  action: VerdictAction
}): boolean =>
  facts.isUser && facts.newish && facts.avatarCount === 0 &&
  (facts.action === 'none' || facts.action === 'observe')

export type ProfileRecheckOutcome = 'still_bare' | 'dressed' | 'dressed_farm'

export const profileRecheckOutcome = (
  hasAvatar: boolean,
  signals: readonly Signal[]
): ProfileRecheckOutcome =>
  !hasAvatar ? 'still_bare' : isFarmShapedProfile(signals) ? 'dressed_farm' : 'dressed'

/**
 * `attempt` counts from zero; `last` is true when no further look will follow,
 * so the caller can write the "still bare" row once instead of once per look.
 */
export type ProfileRecheckLook = (attempt: number, last: boolean) => Promise<'again' | 'done'>

/**
 * In memory on purpose. A deploy drops what is pending, which costs a
 * measurement some of its denominator and costs moderation nothing.
 */
export const createProfileRecheckQueue = (options: {
  delaysMs: readonly number[]
  maxPending: number
  setTimer: (fn: () => void, ms: number) => void
}): { schedule: (key: string, look: ProfileRecheckLook) => boolean; size: () => number } => {
  const pending = new Set<string>()

  const arm = (key: string, look: ProfileRecheckLook, attempt: number): void => {
    const since = attempt === 0 ? 0 : options.delaysMs[attempt - 1]!
    options.setTimer(() => {
      const last = attempt >= options.delaysMs.length - 1
      look(attempt, last)
        .then((next) => {
          if (next === 'again' && !last) arm(key, look, attempt + 1)
          else pending.delete(key)
        })
        .catch(() => { pending.delete(key) })
    }, options.delaysMs[attempt]! - since)
  }

  return {
    schedule: (key, look) => {
      if (options.delaysMs.length === 0) return false
      if (pending.has(key) || pending.size >= options.maxPending) return false
      pending.add(key)
      arm(key, look, 0)
      return true
    },
    size: () => pending.size
  }
}
