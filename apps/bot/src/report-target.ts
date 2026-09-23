/**
 * Who a `/report` names when it is not a reply.
 *
 * A reply needs a message, and the message is exactly what is often gone: the
 * sender deleted it, or never wrote one and is in the chat only to sit there
 * with an advert for a name. So the command also takes the person directly —
 * picked from the member list (Telegram inserts a mention carrying the id,
 * even for somebody with no username), as `@username`, a `t.me/` link, or the
 * numeric id a client shows.
 *
 * Only the first word is read; the rest is the reporter's comment. A username
 * needs its `@` (or the link): a bare `spammer` is a word somebody typed, and
 * reading it as a handle would report whoever happens to own it.
 */
export type ReportTargetRef =
  | { kind: 'id'; id: number }
  | { kind: 'username'; username: string }

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/
/** User ids are positive; a marked chat or channel id is negative. */
const USER_ID = /^[1-9]\d{4,15}$/

export const parseReportTarget = (args: string, mentionedUserIds: number[]): ReportTargetRef | null => {
  const picked = mentionedUserIds.find((id) => Number.isSafeInteger(id) && id > 0)
  if (picked !== undefined) return { kind: 'id', id: picked }

  const words = args.trim().split(/\s+/)
  // "id 123456789" — the label some clients print before the number.
  const first = words[0]?.toLowerCase() === 'id' ? words[1] ?? '' : words[0] ?? ''
  const token = first
    .replace(/^tg:\/\/user\?id=/i, '')
    .replace(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i, '@')

  if (USER_ID.test(token)) {
    const id = Number(token)
    return Number.isSafeInteger(id) ? { kind: 'id', id } : null
  }
  if (!token.startsWith('@')) return null
  const name = token.slice(1)
  return USERNAME.test(name) ? { kind: 'username', username: name } : null
}
