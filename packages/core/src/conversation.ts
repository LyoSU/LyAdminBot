/**
 * Turning a message that stayed in the chat into a line of context for the next
 * evaluation.
 *
 * Three lines of code with one rule that is easy to get backwards, and was
 * (2026-07-31): `authorKind` describes WHO WROTE the line. It does not describe
 * what the line was a reply to.
 *
 * The bug was `authorKind: message.channelComment ? 'channel_post' : 'user'`.
 * `channelComment` is set when a message IS a comment under a channel post —
 * i.e. when a MEMBER wrote it — so in the discussion group of a channel every
 * member's own words were filed as the channel's, with a null author id that
 * also cost them the `[SENDER]` label. The auto-forwarded post, whose sender
 * really is the channel, came out as `[user A]`. Exactly inverted, and the
 * consequence is that in those chats the model saw a conversation nobody had
 * taken part in: a sender's own escalating messages could not be recognised as
 * theirs, which is the single thing the window exists to show.
 */
import type { ConversationLine, NormalizedMessage } from './types.js'

export interface ConversationAuthor {
  id: number
  /** True when the message was sent AS a channel, not by a member of the chat. */
  isChannel: boolean
}

/**
 * The context line for `message`, or null when it carries nothing to remember.
 *
 * Empty text is dropped rather than recorded blank: a window of empty lines
 * tells the model that people were talking and hides what about.
 */
export const conversationLineFor = (
  message: Pick<NormalizedMessage, 'text'>,
  author: ConversationAuthor
): ConversationLine | null => {
  const text = message.text.trim()
  if (text.length === 0) return null
  return {
    authorId: author.id,
    authorKind: author.isChannel ? 'channel_post' : 'user',
    textPreview: message.text
  }
}
