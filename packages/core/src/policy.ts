/**
 * Policy: calibrated pSpam → enforcement action. Separated from scoring so
 * that thresholds (a product decision) never leak into signal weights
 * (a statistics decision).
 *
 * Severity ladder: none < observe < captcha < delete < kick < mute < ban.
 *
 * Design rules:
 *  - Discussion groups (channel comments) get a captcha only when it can be
 *    whispered to the commenter alone. A prompt everyone in a comment thread
 *    reads is clutter the commenter will probably bounce off; an ephemeral one
 *    is invisible to the thread.
 *  - Kick (2026-07-27) fills the gap between "delete the message" and
 *    "restrict the person for a day". A drive-by account that dropped one
 *    promo is removed but may rejoin; the punishment expires the moment they
 *    stop, which is the right shape for a mistake we might have made.
 *  - Ban is reserved for newish users. An established account at ban-level
 *    pSpam is more likely compromised than malicious — mute is reversible.
 *  - Ban is TIMED unless there are hard grounds (Telegram scam/fake flag,
 *    external ban database, labelled spam restriction). A real spam bot does
 *    not wait 30 days to come back; a false positive heals itself.
 *  - Trusted users are capped at delete+vote even at pSpam 0.99: a single
 *    pipeline mistake on a regular must never escalate to kick/mute/ban.
 *  - Voting is for the band where we are NOT confident. Above the mute
 *    threshold the pipeline is sure enough that asking the chat only adds
 *    noise; below it, a second opinion is worth the prompt.
 *  - NaN / out-of-range pSpam fails safe to observe (never to action).
 */
import type { StrictnessPreset, VerdictAction, ChatKind } from './types.js'

export interface PolicyInput {
  pSpam: number
  preset: StrictnessPreset
  chatKind: ChatKind
  captchaEnabled: boolean
  votingEnabled: boolean
  /** Few local messages / fresh local age — the "could be a drive-by" class. */
  userIsNewish: boolean
  /** Chat-level trusted list or trusted reputation. */
  userIsTrusted: boolean
  /**
   * The account is already known bad — a Telegram scam/fake flag, a ban
   * database, a spam restriction, prior confirmed detections. This is what
   * cancels the standing shield below, on the same grounds it already cancels
   * `established_user` and the established-regular exempt: what looks like
   * standing was built out of the spam we are judging.
   */
  userHasHardVerdict: boolean
  /**
   * The captcha can be delivered as an ephemeral message — visible to the
   * suspect alone (Bot API 10.2). This is what lifts the discussion-group
   * exclusion below: the objection to captcha under a channel post was that it
   * clutters a comment thread everybody reads. A prompt nobody else can see
   * does not.
   */
  ephemeralCaptcha?: boolean
  /**
   * Evidence that this account is known-bad rather than merely suspicious:
   * a Telegram scam/fake flag, an external ban listing, or a spam-labelled
   * restriction. Only these earn a permanent ban; everything else expires.
   */
  hasPermanentBanGrounds?: boolean
}

export interface PolicyDecision {
  action: VerdictAction
  needsVote: boolean
  /**
   * Ban length in seconds; null means permanent. Meaningful only when
   * `action === 'ban'` — other actions carry their own fixed windows.
   */
  banDurationSeconds: number | null
}

export interface PresetThresholds {
  ban: number
  mute: number
  kick: number
  delete: number
  /** Lower edge of the grey zone: observe / captcha territory. */
  grey: number
}

/** A timed ban long enough to outlast any campaign, short enough to heal an FP. */
export const TIMED_BAN_SECONDS = 30 * 24 * 60 * 60

/**
 * Actions that remove the message from the chat and act on the sender.
 *
 * Exported because three separate places used to spell this list out by hand
 * (the soft-shape guard, the conversation-window bookkeeping, the executor).
 * Adding `kick` to the union meant remembering all three; whichever one you
 * forgot failed silently and only in production.
 */
export const ENFORCEMENT_ACTIONS = ['delete', 'kick', 'mute', 'ban'] as const

export const isEnforcementAction = (action: VerdictAction): boolean =>
  (ENFORCEMENT_ACTIONS as readonly VerdictAction[]).includes(action)

/**
 * Actions that act on the *person*, not just the message. The distinction is a
 * policy fact, not a formatting detail: `delete` costs the chat one line and
 * heals by itself, while these three take the chat away from the sender. The
 * pipeline requires strictly more evidence before crossing this line
 * (see `mayRemoveSender`).
 */
export const SENDER_REMOVING_ACTIONS = ['kick', 'mute', 'ban'] as const

export const removesSender = (action: VerdictAction): boolean =>
  (SENDER_REMOVING_ACTIONS as readonly VerdictAction[]).includes(action)

export const PRESET_THRESHOLDS: Record<StrictnessPreset, PresetThresholds> = {
  soft: { ban: 0.98, mute: 0.94, kick: 0.86, delete: 0.78, grey: 0.55 },
  standard: { ban: 0.95, mute: 0.88, kick: 0.75, delete: 0.6, grey: 0.4 },
  strict: { ban: 0.92, mute: 0.84, kick: 0.7, delete: 0.55, grey: 0.32 }
}

export const decideAction = (input: PolicyInput): PolicyDecision => {
  const t = PRESET_THRESHOLDS[input.preset] ?? PRESET_THRESHOLDS.standard
  const p = input.pSpam

  // Fail safe: a broken score must never trigger enforcement. `Number.isFinite`
  // alone let an out-of-range value (a miscalibrated port returning 5.0) sail
  // past every threshold straight to ban, so the range is checked too.
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    return { action: 'observe', needsVote: false, banDurationSeconds: null }
  }

  /** Vote only where the pipeline is genuinely unsure (below mute level). */
  const uncertain = input.votingEnabled && p < t.mute
  const decide = (action: VerdictAction, needsVote = false): PolicyDecision =>
    ({ action, needsVote, banDurationSeconds: null })

  // Trusted members are capped at delete regardless of score. This IS the
  // contested case — high confidence against high standing — so it always
  // asks the chat, even above the mute threshold.
  if (input.userIsTrusted && p >= t.delete) {
    return decide('delete', input.votingEnabled)
  }

  // Standing spares an account the two irreversible actions — but standing an
  // account earned by spamming is not standing. Production 2026-07-31: a known
  // repeat offender was muted at pSpam 1.00 twice in half an hour because
  // `userIsNewish` had decayed to false, so the longer it had been spamming the
  // milder its treatment got. Note this only chooses between mute and ban for a
  // message already judged removable; it lowers no threshold.
  const shielded = !input.userIsNewish && !input.userHasHardVerdict

  if (p >= t.ban && !shielded) {
    return {
      action: 'ban',
      needsVote: false,
      banDurationSeconds: input.hasPermanentBanGrounds === true ? null : TIMED_BAN_SECONDS
    }
  }
  if (p >= t.mute) return decide('mute')
  // Kick needs newness: removing an account with local standing over a
  // single grey-band message is worse than deleting it and watching.
  if (p >= t.kick && input.userIsNewish) return decide('kick', uncertain)
  if (p >= t.delete) return decide('delete', uncertain)
  if (p >= t.grey) {
    const captchaAllowed = input.captchaEnabled && input.userIsNewish &&
      (input.chatKind !== 'discussion' || input.ephemeralCaptcha === true)
    return decide(captchaAllowed ? 'captcha' : 'observe')
  }

  return decide('none')
}
