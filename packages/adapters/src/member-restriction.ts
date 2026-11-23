/**
 * What Telegram says is in force on a member right now, read off
 * `getChatMember`. Shared by the two callers that must look before they write:
 * the captcha lift (is the restriction ours to remove?) and the mute (is there
 * a heavier sentence this one would replace?).
 */

/** What Telegram says about the member right now. */
export interface MemberRestriction {
  /** mtcute's `ChatMemberStatus`; `left` also stands for "no participant row". */
  status: string
  /** When the restriction lapses; null for "never" (Telegram's until_date 0). */
  untilMs: number | null
  /** Every send right is withheld — the shape of our mute. */
  allSendBlocked: boolean
}

/** The send rights mtcute's `ChatPermissions` exposes; all false is our mute. */
const SEND_RIGHTS = [
  'canSendMessages', 'canSendMedia', 'canSendStickers', 'canSendGifs', 'canSendGames',
  'canUseInline', 'canAddWebPreviews', 'canSendPolls', 'canSendPhotos', 'canSendVideos',
  'canSendRoundVideos', 'canSendAudios', 'canSendVoices', 'canSendFiles', 'canSendText'
] as const

/** The loose shape read out of `getChatMember`. */
export type MemberRestrictionAnswer = {
  status?: unknown
  restrictions?: ({ untilDate?: unknown } & Partial<Record<(typeof SEND_RIGHTS)[number], unknown>>) | null
} | null | undefined

/**
 * Read `getChatMember`'s answer into the three facts above. An empty answer is
 * mtcute's "not a participant", which has nothing of ours on it.
 */
export const readMemberRestriction = (member: MemberRestrictionAnswer): MemberRestriction => {
  if (!member) return { status: 'left', untilMs: null, allSendBlocked: false }
  const status = typeof member.status === 'string' ? member.status : 'unknown'
  const r = member.restrictions ?? null
  const until = r?.untilDate
  const untilMs = until instanceof Date && Number.isFinite(until.getTime()) && until.getTime() > 0
    ? until.getTime()
    : null
  const allSendBlocked = r !== null && SEND_RIGHTS.every((right) => r[right] === false)
  return { status, untilMs, allSendBlocked }
}
