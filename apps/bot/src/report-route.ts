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
