/**
 * Whether the restriction a captcha is about to lift is the one the captcha put
 * there.
 *
 * Lifting is `restrictChatMember` with empty restrictions, which per the API
 * clears EVERY restriction on the account, not ours alone. Until 2026-10-14
 * every lift site called it blind, so a member an admin had muted by hand in
 * Telegram — a mute this bot never sees, because it is not ours — walked out of
 * it by tapping a captcha button, or by having their whisper fail to deliver.
 *
 * What makes a restriction ours, read off what Telegram reports now:
 *   - it is a mute of every send right, which is the only shape the gate and
 *     its ignored-gate consequence ever impose (`SILENCE_ALL`); and
 *   - it ends no later than the gate itself does. Both of the gate's mutes are
 *     bounded by the gate's expiry by construction (`CAPTCHA_TTL_MS` is derived
 *     from them), so a deadline past it — or none, which is "forever" — was set
 *     by somebody else.
 *
 * An admin mute of the same shape and a shorter length is indistinguishable and
 * is lifted; that is the residue, and it is a mute that would have lapsed within
 * the hour anyway.
 */

import type { MemberRestriction } from '@lyadmin/adapters'

/**
 * Reading `getChatMember` lives with the shared mute, which asks the same
 * question before it restricts (`member-restriction.ts`).
 */
export { readMemberRestriction, type MemberRestriction, type MemberRestrictionAnswer } from '@lyadmin/adapters'

/** Clock disagreement between our expiry and Telegram's `until_date`, plus send latency. */
export const CAPTCHA_LIFT_SLACK_MS = 2 * 60 * 1000

export type CaptchaLift =
  | { kind: 'lift' }
  /** Nothing of ours is in force; the gate is passed without a call. */
  | { kind: 'nothing' }
  /** A restriction is in force and it is not ours — leave it. */
  | { kind: 'foreign'; reason: 'no_expiry' | 'outlasts_gate' | 'partial' }
  /** We could not read it. */
  | { kind: 'unreadable' }

export const captchaLift = (
  current: MemberRestriction | null,
  gateExpiresMs: number,
  slackMs: number = CAPTCHA_LIFT_SLACK_MS
): CaptchaLift => {
  /**
   * A failed read lifts nothing.
   *
   * The two mistakes are not the same size. Lifting blind is the defect this
   * exists to close: it can undo an admin's indefinite mute. Not lifting leaves
   * our own mute in place until it lapses — at most the gate's own length —
   * and on the tap path the member is told to try again and the read is
   * repeated on the next tap, so a passed captcha is not left muted by OUR gate
   * past a transient failure. A failed `getChatMember` is rare next to a
   * failed restrict, which the tap path already answers the same way.
   */
  if (current === null) return { kind: 'unreadable' }
  if (current.status !== 'restricted') return { kind: 'nothing' }
  if (!current.allSendBlocked) return { kind: 'foreign', reason: 'partial' }
  if (current.untilMs === null) return { kind: 'foreign', reason: 'no_expiry' }
  if (current.untilMs > gateExpiresMs + slackMs) return { kind: 'foreign', reason: 'outlasts_gate' }
  return { kind: 'lift' }
}
