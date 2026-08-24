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

/**
 * What the pipeline has already established about the MESSAGE by the time the
 * rules run. Only one thing so far, and it is the one thing that cannot be read
 * off a signal: whether anybody could say anything about the text at all.
 *
 * Defaults to "there was content", so a rule conditioned on emptiness can never
 * fire for a caller that did not explicitly establish it.
 */
export interface MessageContext {
  /** `shouldAbstain`: nothing in the message is classifiable on its own. */
  lowInformation: boolean
}

export const applyDeterministicRules = (
  signals: Signal[],
  message: MessageContext = { lowInformation: false }
): DeterministicVerdict | null => {
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

  /**
   * The account IS the advertisement.
   *
   * Explicit imagery on the profile's own surfaces, plus somewhere the profile
   * sends you, on an account with no history here. That is the escort/porn promo
   * shape, and it is the one spam class this pipeline could not see by
   * construction: it never posts anything worth judging. Production 2026-08-24 —
   * a first message of four words under a channel post, an explicit avatar, and
   * a personal channel whose description is a list of services. The message was
   * `observe`d at pSpam 0, correctly by the pipeline's own reckoning, because
   * the message really did say nothing. The advertisement was the name, the
   * picture and the channel, delivered into the chat by the act of posting at
   * all.
   *
   * `aboutAccount`, therefore, and it means exactly what it says elsewhere in
   * this file: the sender-removal bar asks whether the MESSAGE earned it, which
   * is the wrong question here and would always answer no.
   *
   * `lowInformation` is what keeps this coherent with the position the pipeline
   * already holds — that a promotional profile is a reason to READ the message
   * and never by itself a reason to condemn it. That position is about a message
   * there is something to read: somebody with an explicit profile who joins the
   * conversation gets their sentence judged like anyone else's, and a regression
   * test pins exactly that. This rule fires only where the pipeline has already
   * concluded there is nothing to read, which is the whole repertoire of the
   * class it targets. What was delivered into the chat, in that case, was the
   * profile.
   *
   * Precision comes from the conjunction, and from how high each half is set.
   * NSFW is the sexual categories at their own confidence ≥ 0.8 — explicit
   * imagery, not a swimsuit, and never the recall-tuned `flagged` boolean that
   * once banned people over stylised art. "Points somewhere" is a linked
   * channel, a promo bio or a channel that reads as an advert. Newness is
   * required, and any local standing cancels it. An account with all of that at
   * once has no innocent reading in a chat that did not ask for it — and a chat
   * that did has `enabled`, `trustedUsers` and its own preset.
   *
   * NOT a permanent ban: `aboutAccount` skips the evidence bar, so this is one
   * of the rules that can be wrong without anybody in the chat contradicting it.
   * At 0.93 a newish account is muted and the chat gets a card it can override;
   * raising it past `PRESET_THRESHOLDS.standard.ban` would make it a 30-day ban
   * instead, which is a calibration decision and not a code one.
   */
  const nsfwProfile = has('nsfw_avatar') || has('nsfw_stories') || has('nsfw_linked_channel')
  /**
   * Deliberately NOT `nsfw_linked_channel`, which sits in the half above.
   *
   * It was here in the first draft, and that made the conjunction a fiction: one
   * signal satisfied both halves, so the rule reduced to "the linked channel is
   * explicit" and then claimed the authority of two independent facts. Letting a
   * single observation corroborate itself is the exact defect `priorMatch` was
   * introduced to stop on the learning side.
   *
   * Costs nothing on the case this exists for: a channel reachable from the
   * profile is a channel the profile points at, so `personal_channel` is already
   * raised — it was present on both production accounts.
   */
  const profilePointsSomewhere = has('personal_channel') ||
    has('promo_in_bio') || has('promo_in_linked_channel')
  if (message.lowInformation && nsfwProfile && profilePointsSomewhere && isNewish && !isEstablished) {
    return { kind: 'spam', ruleId: 'nsfw_promo_profile', pSpam: 0.93, aboutAccount: true }
  }

  /**
   * Edit-to-inject, the half of it with no innocent reading: invisible
   * characters wedged in by an edit.
   *
   * The rule used to fire on any injection, links and mentions included, and
   * called the result `edit_injected_promo`. Nothing ever tested that claim —
   * the delta it reads was never computed in production (5969 edits judged, zero
   * of this signal, checked 2026-08-24) — and once it was, the claim did not
   * survive reading: adding a forgotten link is the same edit as the attack.
   * That case now scores through `edit_injected_link`, which reaches the chat
   * with a question instead of a silent mute. Established users stay exempt
   * here, as before: admins fix their own formatting.
   */
  if (has('edit_injected_invisibles') && !isEstablished) {
    return { kind: 'spam', ruleId: 'edit_injected_invisibles', pSpam: 0.93 }
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
