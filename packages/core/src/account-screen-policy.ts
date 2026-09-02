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
  /**
   * Standing earned anywhere, the same counter `established_user` reads.
   * `null` when it could not be read, which excuses nobody from the gate.
   */
  messagesGlobal: number | null
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
  // Explicit, because the exemption is the generous branch: a counter we could
  // not read must not spend a standing the account may not have.
  if (user.messagesGlobal !== null && user.messagesGlobal >= ESTABLISHED_MIN_MESSAGES) {
    return 'established'
  }
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

/**
 * Which message an account-screen outcome takes with it, if any.
 *
 * The same problem as `accountScreenAllowed`, one branch over: `screenAccount`'s
 * ban was written inline and never went through `executor.ts`, where every
 * removal action deletes the message as its first line. So the invariant the
 * whole rest of the codebase holds — the person goes, what they posted goes —
 * simply was not there, and a report answered by a thirty-day ban left the
 * reported message standing.
 *
 * `subjectMessageId` is a message the TARGET sent. It is not the same thing as
 * the id the screen replies to: the `reported_arrival` path is handed Telegram's
 * own join line, which belongs to nobody and is not what anyone reported.
 *
 * A gate returns null on purpose. It is a question, and a question that deletes
 * the thing it is asking about has answered itself — the same line the message
 * path draws when it caps profile-only evidence at a captcha.
 *
 * A hold is not a gate. It is what is left when the question cannot be put
 * (see `accountScreenUnasked`), it is recorded and shown as a mute, and a mute
 * takes the message with it — `executor.ts` deletes as the first line of every
 * `mute`, and keeps the message only under `captcha`. Production 2026-09-02:
 * the first hold this branch ever applied left the reported message standing
 * for the hour, because the branch was written as the gate minus its whisper
 * and inherited the gate's answer here. The message under profile spam is the
 * bait — a harmless word that exists to get the profile opened — and the report
 * was about the bait.
 */
export const accountScreenRemoves = (
  action: 'ban' | 'gate' | 'hold',
  subjectMessageId: number | null,
): number | null => {
  if (action === 'gate') return null
  // Not `!= null`: `0` is the neighbouring sentinel for "no message" (see the
  // card key, `replyToMessageId ?? 0`), and a delete built from a sentinel is a
  // delete aimed at whatever id 0 resolves to.
  return typeof subjectMessageId === 'number' && subjectMessageId > 0 ? subjectMessageId : null
}

/**
 * What is left of a report when the question it bought cannot be put.
 *
 * `screenAccount` ends in `gateAccount`, and a gate is two things: a hold, and
 * a question asked inside it. Until now, when the question could not be
 * delivered the hold came off with it — `deliverCaptcha` lifts the restriction
 * and drops the gate, on the reasoning that a mute for a question nobody was
 * asked is a punishment for silence that was never anyone's fault.
 *
 * That reasoning is sound about the QUESTION and wrong about the hold, because
 * the hold was not bought by the question. It was bought by a person in the
 * room pressing report, and by a profile the screen then found a case in.
 * Neither of those stops being true because a whisper had nowhere to land.
 *
 * ── the measurement, 2026-09-01 ──
 *
 * 20 rows, 19 accounts, every one of them reported by a human and gated by the
 * screen. Every single one carries `avatar_recently_set` with `new_in_chat` and
 * `new_globally`, and every one carries `private_invite_in_bio`,
 * `suggestive_profile_media`, or both. Fourteen carry `avatar_shared_with_
 * accounts` — the same profile photo on 1, 3, 4, 11, 14, 15, 18, 19 and 35
 * other accounts. Sixteen of the nineteen were never punished by anything, and
 * the three that were needed a SECOND human report to get there.
 *
 * The delivery failure is one line, four times over in one afternoon:
 * `Telegram API error 400: USER_NOT_PARTICIPANT` — a commenter under a channel
 * post is not a member of the discussion group, and an ephemeral message can
 * only be shown to a member.
 *
 * ── why a hold and not a ballot ──
 *
 * A ballot was the obvious answer and the data refuses it: all 19 of these
 * accounts ALREADY had one. `/report` opens a vote 0.3s before the screen even
 * runs, so a fallback ballot would be a second prompt about a target the room
 * is already being asked about. Network-wide those ballots stand at 145 expired
 * against 73 resolved, and the two accounts this was written for still sat at
 * two voters each, hours later.
 *
 * So the hold is not a verdict and not a substitute for one. It is the room's
 * open question given somewhere to be answered from — the account cannot post
 * while it runs, and a ham ballot lifts it early through the ordinary
 * restitution path.
 *
 * ── which blockers reach here ──
 *
 * `sender_not_participant` alone: Telegram naming the person and saying they
 * are not a member. It is a fact about the network, and no chat chose it.
 *
 * `captcha_disabled` is a chat that switched this off, and answering a setting
 * with a mute overrules it. `sender_is_channel` cannot be muted without being
 * banned outright (see `mayAskCaptcha`), and is the message path's business.
 * `discussion_without_ephemeral` is the privacy promise the ask was granted on.
 * None of them hold anybody.
 *
 * `votingEnabled` gates the whole thing, because the hold's justification is
 * that the room is being asked instead. A chat with no ballot has no way to
 * answer, and a six-hour mute nobody can lift is a punishment on profile
 * evidence alone — the line the message path draws and this must not cross.
 */
export const accountScreenUnasked = (
  blockers: readonly string[],
  votingEnabled: boolean,
): 'hold' | 'none' => {
  if (!votingEnabled) return 'none'
  if (blockers.length === 0) return 'none'
  // Every blocker must be one the network imposed. A chat's own setting sitting
  // anywhere in the list is the chat's answer, and it stands.
  return blockers.every((b) => b === 'sender_not_participant') ? 'hold' : 'none'
}
