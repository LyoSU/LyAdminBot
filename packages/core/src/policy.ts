/**
 * Policy: calibrated pSpam → enforcement action. Separated from scoring so
 * that thresholds (a product decision) never leak into signal weights
 * (a statistics decision).
 *
 * Severity ladder: none < observe < captcha < delete < mute < ban.
 *
 * Design rules:
 *  - Discussion groups (channel comments) never get captcha — a commenter
 *    who came from a channel post would just bounce; delete+vote instead.
 *  - Ban is reserved for newish users. An established account at ban-level
 *    pSpam is more likely compromised than malicious — mute is reversible.
 *  - Trusted users are capped at delete+vote even at pSpam 0.99: a single
 *    pipeline mistake on a regular must never escalate to mute/ban.
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
}

export interface PolicyDecision {
  action: VerdictAction
  needsVote: boolean
}

export interface PresetThresholds {
  ban: number
  mute: number
  delete: number
  /** Lower edge of the grey zone: observe / captcha territory. */
  grey: number
}

export const PRESET_THRESHOLDS: Record<StrictnessPreset, PresetThresholds> = {
  soft: { ban: 0.98, mute: 0.92, delete: 0.78, grey: 0.55 },
  standard: { ban: 0.95, mute: 0.85, delete: 0.6, grey: 0.4 },
  strict: { ban: 0.92, mute: 0.8, delete: 0.55, grey: 0.32 }
}

export const decideAction = (input: PolicyInput): PolicyDecision => {
  const t = PRESET_THRESHOLDS[input.preset] ?? PRESET_THRESHOLDS.standard
  const p = input.pSpam

  // Fail safe: a broken score must never trigger enforcement.
  if (!Number.isFinite(p)) return { action: 'observe', needsVote: false }

  if (input.userIsTrusted && p >= t.delete) {
    return { action: 'delete', needsVote: input.votingEnabled }
  }

  if (p >= t.ban && input.userIsNewish) return { action: 'ban', needsVote: false }
  if (p >= t.mute) return { action: 'mute', needsVote: false }
  if (p >= t.delete) return { action: 'delete', needsVote: input.votingEnabled }
  if (p >= t.grey) {
    const captchaAllowed =
      input.captchaEnabled && input.userIsNewish && input.chatKind !== 'discussion'
    return { action: captchaAllowed ? 'captcha' : 'observe', needsVote: false }
  }

  return { action: 'none', needsVote: false }
}
