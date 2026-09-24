/**
 * Quiet mode: how long a moderation notice stays in the chat, and whether it
 * makes a sound.
 *
 * A chat that turns it on asked for the bot to be heard only when it needs
 * somebody. A notice about an action the bot was sure of is a statement, and
 * in quiet mode a statement is up for seconds, arrives without a sound and
 * carries no buttons: its "why?" link opens the card in the bot's PM, where
 * "Not spam" and the profile are. It is not lost either: Telegram keeps the
 * deleted notice, link included, in the group's Recent actions, which only
 * admins can open.
 *
 * A question is never quieted. `needsVote` is the verdict's own "I am not
 * sure", and it holds whether the chat is asked by ballot or — with voting off —
 * shown an enforcement that was unsure. Keying this on the ballot rather than on
 * the verdict would silence exactly the notices the mode promises to keep.
 */

/** How long a quiet notice stays up. */
export const NOTIFY_TTL_QUIET_MS = 5 * 1000

export interface NoticeDelivery {
  ttlMs: number
  silent: boolean
  /**
   * Whether the notice keeps its keyboard. A quiet one does not, as long as
   * its text links to the PM card — without the bot's username there is no
   * link, and the button is then the only way to correct it.
   */
  buttons: boolean
}

export const noticeDelivery = (
  policy: { quietMode?: boolean | undefined },
  verdict: { needsVote: boolean },
  loudTtlMs: number,
  botUsername: string | null
): NoticeDelivery =>
  policy.quietMode === true && !verdict.needsVote
    ? { ttlMs: Math.min(NOTIFY_TTL_QUIET_MS, loudTtlMs), silent: true, buttons: botUsername === null }
    : { ttlMs: loudTtlMs, silent: false, buttons: true }
