/**
 * Which chat-level guards an account screen must clear, per action.
 *
 * `screenAccount` reaches two conclusions about an account nobody has a message
 * from: a ten-minute gate undone by one tap, and a thirty-day ban. Until
 * 2026-08-26 the gate ran five chat-level checks and the ban ran none — not by
 * decision, but because the checks lived inside `gateAccount` and the ban was
 * written inline three lines above the call to it. The milder action was
 * guarded and the severe one was not.
 *
 * Nothing in the shape of that code said so. Guards that belong to a DECISION
 * cannot live in one of the functions the decision dispatches to; a branch that
 * returns earlier simply does not have them, and no test of either branch can
 * see the hole. So they live here, in one place, keyed by the action.
 *
 * ── what is deliberately NOT symmetric ──
 *
 * Trust and standing spare a member the gate and do NOT shield them from a ban.
 * That is `executor.ts`'s rule from 2026-07-30, kept: trust is a shield against
 * OUR judgement, not against somebody else's verdict. A ban here is only ever
 * reached through `hasHardAccountVerdict` — a Telegram scam flag, an external
 * listing, an integrity finding — and treating a single tap on the override
 * button as immunity against those is how a sold long-time account survives.
 *
 * The point of one function is that this difference is now stated rather than
 * implied by where a line happens to sit.
 */
import { ESTABLISHED_MIN_MESSAGES } from './signals/user.js'
import { PERMANENT_BAN_SIGNALS, THIRD_PARTY_VERDICT_SIGNALS } from './signals/registry.js'

/** What the chat has switched on. A subset of `ChatPolicy`, by hand, so this
 * module stays free of the pipeline's input types. */
export interface AccountScreenChat {
  /** The master anti-spam switch. */
  enabled: boolean
  captchaEnabled: boolean
  /** Whether this chat honours external ban databases (lols/CAS). */
  externalBanEnabled: boolean
  trustedUserIds: readonly number[]
}

export interface AccountScreenUser {
  id: number
  /** Standing earned anywhere, the same counter `established_user` reads. */
  messagesGlobal: number
}

/**
 * Where a hard account verdict came from, when the action is a ban.
 *
 * `third_party` is lols/CAS and is the only one a chat can decline, through
 * `externalBanEnabled`. A Telegram scam flag is not a third party and that
 * setting says nothing about it; an integrity finding is our own reading of the
 * account and is covered by the master switch alone.
 */
export type HardVerdictSource = 'third_party' | 'platform' | 'integrity'

export type AccountScreenRefusal =
  | 'antispam_off'
  | 'external_ban_off'
  | 'captcha_off'
  | 'trusted'
  | 'established'

export const accountScreenAllowed = (
  action: 'ban' | 'gate',
  chat: AccountScreenChat,
  user: AccountScreenUser,
  hardVerdictSource: HardVerdictSource = 'platform',
): 'allow' | AccountScreenRefusal => {
  // First, and for both: a chat that turned the pipeline off did not ask to be
  // policed at the door instead.
  if (!chat.enabled) return 'antispam_off'

  if (action === 'ban') {
    if (hardVerdictSource === 'third_party' && !chat.externalBanEnabled) return 'external_ban_off'
    return 'allow'
  }

  if (!chat.captchaEnabled) return 'captcha_off'
  if (chat.trustedUserIds.includes(user.id)) return 'trusted'
  if (user.messagesGlobal >= ESTABLISHED_MIN_MESSAGES) return 'established'
  return 'allow'
}

/**
 * Which authority a hard account verdict rests on, for the one chat setting
 * that can decline one of them.
 *
 * Ordered by how little the chat may argue with it: Telegram's own flag first,
 * then our integrity reading, and `third_party` only when the listing is the
 * whole of the case. A listed account that ALSO carries a scam flag is not a
 * third-party verdict — the flag stands on its own, and a chat that declined
 * the ban lists never said anything about Telegram's.
 */
export const hardVerdictSourceOf = (
  signals: readonly { name: string }[],
): HardVerdictSource => {
  const names = new Set(signals.map((s) => s.name))
  for (const name of names) if (PERMANENT_BAN_SIGNALS.has(name as never)) return 'platform'
  for (const name of names) if (THIRD_PARTY_VERDICT_SIGNALS.has(name as never)) return 'third_party'
  return 'integrity'
}
