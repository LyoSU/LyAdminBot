/**
 * What may be concluded about an ACCOUNT when there is no message to read.
 *
 * Every other verdict in this pipeline starts from something somebody sent.
 * Two places have no such thing: a joiner who has not spoken yet, and an
 * account a member has reported by replying to its arrival. Both need an
 * answer, and both were answered by copies of one rule written twice — so this
 * is the rule, written once.
 *
 * ── Why the ceiling is a question and not a removal ──
 *
 * `SENDER_REMOVAL_MIN_EVIDENCE` says removing a person takes evidence about a
 * MESSAGE. Here there is no message at all, so by that rule nothing here may
 * remove anybody. What it may do is close a gate the person opens themselves
 * with one tap: a bot cannot, a person we were wrong about spends a second.
 *
 * The single exception is an account another authority has already judged —
 * `hasHardAccountVerdict`: a scam flag from Telegram itself, an external ban
 * list, a history of confirmed detections. That is not our inference about a
 * profile; it is a finding somebody else made and we are honouring, and the
 * deterministic `external_ban_new` rule has acted on it without a message for
 * as long as it has existed.
 */
import type { Signal } from '../types.js'
import {
  PROFILE_EVIDENCE_SIGNALS, SIGNAL_GROUP_CAPS, weightOf
} from './registry.js'
import { DECISIVE_MIN_WEIGHT } from '../score.js'

/**
 * `ban` — somebody else already judged this account.
 * `gate` — mute and ask, undone by one tap.
 * `none` — nothing here justifies touching a person who has said nothing.
 */
export type AccountAction = 'ban' | 'gate' | 'none'

/**
 * Profile evidence needed to close a gate on somebody who has said nothing.
 *
 * Set at the weight of the lightest single fact that plainly describes an
 * advertising account rather than a person — a private invite in the bio
 * (1.5). Below it sit exactly the facts that describe ordinary people too: a
 * suggestive picture (0.8), a recently changed avatar (0.6), a link to one's
 * own channel (0.5). Those may contribute, never decide.
 */
export const ACCOUNT_GATE_MIN_WEIGHT = 1.5

/**
 * An avatar that is pornography, which gates on its own.
 *
 * Called out rather than folded into the weight test because its signal weight
 * (1.0) is calibrated for a message verdict, where it is one input among many.
 * As a statement about an account it is not one input among many, and the join
 * screen has treated it as sufficient since it was written. Two places
 * disagreeing about that was the thing this module exists to prevent.
 */
const DECISIVE_ALONE = new Set<string>(['nsfw_avatar'])

/**
 * The profile's case against an account, in weight.
 *
 * Three exclusions, each borrowed from the removal bar rather than invented:
 * only signals ABOUT THE PROFILE count, sub-threshold nudges are dropped
 * entirely instead of stacking, and correlated signals share their group's
 * ceiling — one profile advertised in three places is one finding.
 */
const profileWeight = (signals: readonly Signal[]): number => {
  let total = 0
  const groupTotals = new Map<string, number>()
  for (const name of new Set(signals.map((s) => s.name))) {
    if (!PROFILE_EVIDENCE_SIGNALS.has(name as never)) continue
    const weight = weightOf(name)
    if (weight < DECISIVE_MIN_WEIGHT) continue
    const group = SIGNAL_GROUP_CAPS.find((g) => g.members.has(name as never))
    if (group) groupTotals.set(group.name, (groupTotals.get(group.name) ?? 0) + weight)
    else total += weight
  }
  for (const group of SIGNAL_GROUP_CAPS) {
    const grouped = groupTotals.get(group.name)
    if (grouped !== undefined) total += Math.min(grouped, group.cap)
  }
  return total
}

/**
 * Profile facts that may ask a question on their own, once a message has come
 * up empty.
 *
 * A superset of `DECISIVE_ALONE`, and the difference is deliberate rather than
 * an oversight. That set answers "may this account be gated on arrival, having
 * said nothing at all"; this one answers "may this account be gated after
 * saying something that turned out to carry nothing". The second has a message
 * in hand and a person already in the room, so a suggestive picture — measured
 * 2026-08-24 on a real promo account at sexual 0.373, and explicitly ruled
 * "strong, not decisive" — may ask here and not at the door.
 */
const ASKS_ALONE = new Set<string>([...DECISIVE_ALONE, 'suggestive_profile_media'])

/**
 * Whether the profile has enough of a case to ask somebody a question.
 *
 * Shared with the message pipeline's `low_information_profile` branch, which
 * used to guard itself with a membership test over the whole profile-evidence
 * set. Production 2026-08-26 16:01: an account 3308 days old was handed a
 * captcha for tagging two members, because `promo_in_bio` — 0.3, a link in the
 * bio, present in 22% of the 3797 bios measured on 2026-08-25 and BELOW the
 * base rate for spam — unlocked a branch whose whole purpose is to stop three
 * newness signals asking a stranger to prove they are human.
 *
 * One question, one answer, in one place.
 */
export const profileHasCase = (signals: readonly Signal[]): boolean =>
  signals.some((s) => ASKS_ALONE.has(s.name)) ||
  profileWeight(signals) >= ACCOUNT_GATE_MIN_WEIGHT

/**
 * Judge the account alone.
 *
 * `hardAccountVerdict` is `hasHardAccountVerdict(user)` at the call site — kept
 * as a plain boolean so this module needs nothing but a list of signal names,
 * which is what makes its table of answers testable.
 */
export const accountVerdict = (
  signals: readonly Signal[],
  context: { hardAccountVerdict: boolean }
): AccountAction => {
  if (context.hardAccountVerdict) return 'ban'
  if (signals.some((s) => DECISIVE_ALONE.has(s.name))) return 'gate'
  return profileWeight(signals) >= ACCOUNT_GATE_MIN_WEIGHT ? 'gate' : 'none'
}
