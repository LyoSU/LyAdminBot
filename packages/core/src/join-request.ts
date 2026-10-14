/**
 * What the door would answer to a JOIN REQUEST — SHADOW: nothing here approves,
 * declines or asks anybody anything.
 *
 * ── why, 2026-10-14 ──
 *
 * A chat that turns on "approve new members" sends its admin bots a join
 * request (`updateBotChatInviteRequester`) before the person is in the room.
 * The bot did not subscribe to that update at all, so there is no number for
 * how many of our chats use approvals, nor for how many requesters the screen
 * an arrival already gets would have turned away. A declined request costs the
 * chat nothing — no join line, no advert, no cleanup — which is why it is worth
 * pricing; whether it is worth DOING is what the rows this feeds are for.
 *
 * ── the mechanism ──
 *
 * The answer is the arrival screen's, read without acting, so the two cannot
 * drift: `hasBanGradeAccountVerdict` is the bar `banJoinerOnRecord` bans on,
 * `accountScreenAllowed('ban', …)` is the chat-level guard `banOnRecord` holds
 * that ban to, and `isFarmShapedProfile` / `accountVerdict` are what the
 * arrival look reads. Mapped onto what a join request can be told:
 *  - `decline` — the account would be banned on its record at the door.
 *  - `look`    — the arrival look would gate it (or it wears the farm's shape):
 *                the request would be left for an admin, not answered.
 *  - `approve` — nothing the door reads says anything.
 */
import type { Signal, UserSnapshot } from './types.js'
import {
  accountScreenAllowed, hardVerdictSourceOf, isFarmShapedProfile,
  type AccountScreenChat, type AccountScreenRefusal
} from './account-screen-policy.js'
import { accountVerdict } from './signals/account-verdict.js'
import {
  ESTABLISHED_MIN_MESSAGES, PRIOR_DETECTIONS_MIN, hasBanGradeAccountVerdict, isStaleExternalBan
} from './signals/user.js'

export type JoinRequestDecision = 'decline' | 'look' | 'approve'

/** Which record a `decline` rests on — the first that holds, in the order below. */
export type BanGradeReason =
  | 'scam_flag' | 'fake_flag' | 'external_listing' | 'prior_detections' | 'restricted'

export type JoinRequestReason =
  | BanGradeReason
  /** Ban-grade record, but this chat's guard refuses the ban (see `blocked`). */
  | 'decline_refused'
  | 'antispam_off'
  | 'trusted'
  | 'established'
  | 'farm_shape'
  | 'profile_case'
  | 'clean'

export interface JoinRequestVerdict {
  wouldDecide: JoinRequestDecision
  reason: JoinRequestReason
  /** Set only with `decline_refused` / `antispam_off`: the guard's own answer. */
  blocked?: AccountScreenRefusal
}

/**
 * Which ban-grade fact the account carries, or null. Non-null exactly when
 * `hasBanGradeAccountVerdict` is true — the test holds the two to that, so a
 * new fact added to one and not the other fails rather than mislabels.
 */
export const banGradeReasonOf = (user: UserSnapshot, now = Date.now()): BanGradeReason | null => {
  if (user.flags.scam) return 'scam_flag'
  if (user.flags.fake) return 'fake_flag'
  if (user.externalBan?.banned === true && !isStaleExternalBan(user, now)) return 'external_listing'
  if (user.spamDetections >= PRIOR_DETECTIONS_MIN) return 'prior_detections'
  if (user.restrictionReasons.some((r) => /spam|scam/i.test(r))) return 'restricted'
  return null
}

export const joinRequestVerdict = (input: {
  user: UserSnapshot
  /** User signals plus whatever the profile and avatar reads added. */
  signals: readonly Signal[]
  chat: AccountScreenChat
  now?: number
}): JoinRequestVerdict => {
  const { user, signals, chat } = input
  const now = input.now ?? Date.now()
  // The caller records nothing for such a chat; answered anyway so the
  // function is total.
  if (!chat.enabled) return { wouldDecide: 'approve', reason: 'antispam_off', blocked: 'antispam_off' }

  if (hasBanGradeAccountVerdict(user, now)) {
    const allowed = accountScreenAllowed('ban', chat, {
      id: user.id, messagesGlobal: user.messagesGlobal
    }, hardVerdictSourceOf(signals))
    if (allowed !== 'allow') return { wouldDecide: 'approve', reason: 'decline_refused', blocked: allowed }
    // Non-null by the invariant above; the fallback keeps the type honest.
    return { wouldDecide: 'decline', reason: banGradeReasonOf(user, now) ?? 'restricted' }
  }

  // The shields the arrival look honours before it pays for anything: standing
  // earned elsewhere, and the chat's own word for this person.
  if (chat.trustedUserIds.includes(user.id)) return { wouldDecide: 'approve', reason: 'trusted' }
  if ((user.messagesGlobal ?? 0) >= ESTABLISHED_MIN_MESSAGES) {
    return { wouldDecide: 'approve', reason: 'established' }
  }

  if (isFarmShapedProfile(signals)) return { wouldDecide: 'look', reason: 'farm_shape' }
  if (accountVerdict(signals, { hardAccountVerdict: false }) === 'gate') {
    return { wouldDecide: 'look', reason: 'profile_case' }
  }
  return { wouldDecide: 'approve', reason: 'clean' }
}
