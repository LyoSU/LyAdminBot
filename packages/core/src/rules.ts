/**
 * Deterministic rules: high-precision signal combinations that decide
 * without an LLM call. Philosophy (carried over from v1, recalibrated
 * against the 2026-06 production review): precision >> recall. A rule that
 * cannot keep ~zero FP gets deleted or demoted to scoring, not "tuned".
 *
 * Notable absences, on purpose:
 *  - sleeper_awakened: v1's sleeper_awakened_promo (c=90) was the #1 action
 *    source and the #1 confirmed-FP source. Sleeper accounts now go through
 *    scoring + LLM and land in the votable band.
 *  - mass-blast / language-mismatch / dormancy rules: they need behavioural
 *    accumulators that arrive with the stats layer; reintroduce only with
 *    replay-measured precision.
 */
import type { Signal } from './types.js'
import {
  PROMO_SIGNALS, HIGH_RISK_SIGNALS, isTrustSignal, type SignalName
} from './signals/registry.js'

export interface DeterministicVerdict {
  kind: 'spam' | 'clean'
  ruleId: string
  /** Calibrated probability this rule asserts. */
  pSpam: number
  /**
   * The rule rests on somebody else's verdict about the ACCOUNT — Telegram's
   * own scam/fake flag, its unofficial-client warning, a community ban database
   * — rather than on anything in the message.
   *
   * It is what exempts a rule from the sender-removal bar. That bar asks
   * whether the MESSAGE earned the removal, which is the wrong question to put
   * to a listing: the answer is always no, and capping these would quietly
   * disable them. Every other rule here points at something in the message and
   * is held to the same evidence bar as the scoring path — see the note in
   * `pipeline.ts` and the 2026-08-01 mute.
   */
  aboutAccount?: true
}

/**
 * Note on `established_user` (2026-07-27): it had been unreachable, because it
 * required a reputation score that v2 never writes. Making it reachable meant
 * it would suddenly start shielding accounts from the rules below — including
 * scam-flagged and externally-banned ones. That is prevented at the source:
 * `extractUserSignals` refuses to emit `established_user` for an account any
 * hard verdict already condemns, so no extra guard is needed here.
 */

export const applyDeterministicRules = (signals: Signal[]): DeterministicVerdict | null => {
  const names = new Set(signals.map((s) => s.name))
  const has = (n: SignalName): boolean => names.has(n)

  const hasPromo = [...names].some((n) => PROMO_SIGNALS.has(n))
  const hasHighRisk = [...names].some((n) => HIGH_RISK_SIGNALS.has(n))
  const hasAnySuspicious = signals.some((s) => !isTrustSignal(s.name))
  const isNewish = has('new_globally') || has('new_in_chat')
  const isEstablished = has('established_user') || has('trusted_reputation')

  // ── SPAM rules ──────────────────────────────────────────────────────

  // Telegram itself marked the account as scam/fake AND it is new to us.
  // Established accounts are excluded: scam flags survive appeals for a
  // while and a long-time local member deserves the full pipeline.
  if ((has('scam_flag') || has('fake_flag')) && isNewish && !isEstablished) {
    return { kind: 'spam', ruleId: 'scam_flag_new', pSpam: 0.97, aboutAccount: true }
  }

  // Telegram's own dangerous-unofficial-client flag (userFull
  // .unofficial_security_risk). Per product decision this outweighs even
  // scam/fake, so unlike scam_flag_new it does not require newness — only
  // an established/trusted local member is spared the deterministic call.
  if (has('unofficial_client_risk') && !isEstablished) {
    return { kind: 'spam', ruleId: 'unofficial_client_new', pSpam: 0.97, aboutAccount: true }
  }

  // External ban databases (CAS/lols) + no meaningful local history.
  // Local-history requirement guards against rehabilitated accounts —
  // the known FP class of these databases.
  if (has('external_ban') && has('new_globally') && !isEstablished) {
    return { kind: 'spam', ruleId: 'external_ban_new', pSpam: 0.96, aboutAccount: true }
  }

  // Edit-to-inject: message edited to insert URL/mention/invisibles.
  // Structurally near-zero FP; established users exempt (admins fix links).
  if (has('edit_injected_promo') && !isEstablished) {
    return { kind: 'spam', ruleId: 'edit_injected_promo', pSpam: 0.93 }
  }

  // Private invite link from an account with no global history.
  if (has('private_invite_link') && has('new_globally') && !isEstablished) {
    return { kind: 'spam', ruleId: 'private_invite_new', pSpam: 0.93 }
  }

  // Identity churn on a fresh account is only spam WITH promo content —
  // prod confirmed an FP on an innocent question from a renamed account.
  if (has('identity_churn_24h') && has('fresh_account') && (hasPromo || hasHighRisk)) {
    return { kind: 'spam', ruleId: 'identity_churn_promo', pSpam: 0.9 }
  }

  // Deceptive hidden URL from a chat newcomer.
  if (has('hidden_url') && has('new_in_chat') && !isEstablished) {
    return { kind: 'spam', ruleId: 'hidden_url_new', pSpam: 0.9 }
  }

  // ── CLEAN rules ─────────────────────────────────────────────────────
  // Skipping the pipeline for legit regulars is the main FP-reduction
  // lever. Guard: any promo/high-risk signal disables the shortcut
  // (compromised trusted accounts post promo too).

  if (has('trusted_reputation') && !hasAnySuspicious) {
    return { kind: 'clean', ruleId: 'trusted_clean', pSpam: 0.02 }
  }

  if (has('established_user') && has('is_reply') && !hasAnySuspicious) {
    return { kind: 'clean', ruleId: 'established_reply_clean', pSpam: 0.03 }
  }

  return null
}
