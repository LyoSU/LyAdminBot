/**
 * What a `/report` on a message does once its ballot has been read back.
 *
 * Until 2026-10-14 the command had two outcomes after the ballot — an admin's
 * instant resolution, or the community prompt — and both required the vote to
 * be OPEN. A vote is keyed by (chat, message) and `openVote` refuses a
 * duplicate, so a report on a message whose question had already expired or
 * closed found the old row, cast nothing into it, and fell off the end of the
 * handler: the command was deleted and nobody was answered, an admin included.
 * Measured: 216 bot-opened votes expired in 6.5 days, every one of them a
 * message a later report could land on.
 *
 * - `resolve`: the admin path that already existed — close the open vote, act.
 * - `rerule`: an admin on a closed question. A fresh ruling on the message,
 *   enforced directly; the stale vote is not reopened (see `rulesFirst`).
 * - `closed`: anybody else on a closed question. They are told it is closed;
 *   the account screen still runs, so the report is not wasted.
 * - `community`: the ordinary open-vote path (prompt, or nothing if no vote).
 */
export type ReportVoteRoute = 'resolve' | 'rerule' | 'closed' | 'community'

export interface ReportVoteState {
  /** The stored vote's status, or null when it could not be read at all. */
  status: string | null
  /** Whether the tally on the open vote is a spam outcome. */
  tallySpam: boolean
  reporterIsAdmin: boolean
}

export const reportVoteRoute = (s: ReportVoteState): ReportVoteRoute => {
  // An unreadable vote is a storage failure, not a closed question: telling
  // the reporter "it is closed" would be a guess. The community path already
  // does nothing for a null vote, which is the honest answer to not knowing.
  if (s.status === null) return 'community'
  if (s.status === 'open') return s.tallySpam ? 'resolve' : 'community'
  return s.reporterIsAdmin ? 'rerule' : 'closed'
}

/**
 * Whether a re-ruling on a closed vote may write the durable consequences of a
 * spam ruling — the detection against the account, the learned text, the label.
 *
 * Not when the question already closed as `spam`: those were written when it
 * did, and a second report on the same message (possible only when its delete
 * failed the first time) would count one message twice against its author and
 * feed the same text to the stores twice. The removal and the mute are still
 * re-applied; they are the part that evidently did not stick.
 */
export const rulesFirst = (closedStatus: string): boolean => closedStatus !== 'spam'

/**
 * Which `/report` this is: about the message it replies to, or about the
 * person it names.
 *
 * A reply is not always a reply. In the comments under a channel post every
 * message carries a reply to the thread's root — the post the channel
 * auto-forwarded into the discussion group — and in a forum topic every
 * message carries a reply to the topic's creation line. Telegram sets those
 * whether or not the person pressed "reply". Until 2026-10-14 `/report @name`
 * typed in either place was read as a report on the channel post or on the
 * service line, and answered "reply to a message": the named form was dead
 * exactly where comment spam lands.
 *
 * So a reply to a thread root counts as no reply when the command names
 * somebody. With nothing named it stays a reply, and the reply path explains
 * what it can and cannot do with a root.
 */
/**
 * A report on a message posted AS a chat rather than by a person.
 *
 * Until 2026-10-14 every such report was answered "reply to a message" —
 * which the reporter had just done. The pipeline has judged channel senders
 * since 2026-07-30, so spam from a channel identity is a real shape, and the
 * one place a member could flag the pipeline's miss told them they had used
 * the command wrong.
 *
 * - `admin_post`: the group posting as itself — an anonymous admin.
 * - `thread_root`: the linked channel's own post, mirrored into its discussion
 *   group; a report on it is the implicit reply of a comment (see `reportPath`).
 * - `ban`: an admin's report on a channel identity. A channel cannot be muted
 *   — a sender chat is posting or banned, nothing between — so the ruling is a
 *   ban of that identity, which costs no person anything.
 * - `explain`: anybody else, who is told only an admin can act on it. Not a
 *   community vote: the vote's sanction is a mute, which a channel ignores.
 *
 * The shape test is `shouldScanChannelSender`'s, passed in, so the report and
 * the pipeline cannot disagree on which channel senders are ours to judge.
 */
export type ChannelReportRoute = 'admin_post' | 'thread_root' | 'ban' | 'explain'

export const channelReportRoute = (p: {
  senderId: number
  chatId: number
  isAutomaticForward: boolean
  /** `shouldScanChannelSender` for this message. */
  judgeable: boolean
  reporterIsAdmin: boolean
}): ChannelReportRoute => {
  if (p.senderId === p.chatId) return 'admin_post'
  if (p.isAutomaticForward || !p.judgeable) return 'thread_root'
  return p.reporterIsAdmin ? 'ban' : 'explain'
}

export interface RepliedShape {
  /** The channel post Telegram copied into the discussion group. */
  isAutomaticForward: boolean
  /** mtcute's `MessageAction.type`, or null for an ordinary message. */
  actionType: string | null
}

export const isThreadRoot = (replied: RepliedShape): boolean =>
  replied.isAutomaticForward || replied.actionType === 'topic_created'

export const reportPath = (replied: RepliedShape | null, args: string): 'named' | 'reply' => {
  if (replied === null) return 'named'
  return isThreadRoot(replied) && args.trim() !== '' ? 'named' : 'reply'
}
