/**
 * Greetings this bot posted, kept only long enough for a verdict to take one
 * back.
 *
 * A welcome is the one message the bot writes *about a person* rather than
 * about a message, and it is addressed to the whole chat. When the pipeline
 * then removes that person, the greeting is left standing as our own public
 * endorsement of an account we have just judged — and it carries the spammer's
 * display name a second time, which is exactly what the removal was for.
 *
 * Memory-only, like `IncidentTracker` and `SenderMessageLog` and for the same
 * reason: it records no judgement, so a restart costs nothing but the tidying.
 * The greeting has its own scheduled deletion (persistent) which remains the
 * backstop — all this does is bring that moment forward.
 */

/** Bounded so a bot in thousands of chats cannot grow this without limit. */
export const GREETING_MAX_TRACKED = 1000

export interface RememberedGreeting {
  /** Every message the greeting occupied — a gif and its caption are two. */
  readonly messageIds: readonly number[]
  /**
   * How many newcomers this one greeting named.
   *
   * A bulk add is greeted once for everybody in it, so a greeting that named
   * three people is still true about the two we did not remove. The caller
   * decides; the count is recorded here because only this side knows it.
   */
  readonly subjects: number
}

interface Entry {
  messageIds: readonly number[]
  /**
   * Everyone the greeting named — the ids, not a count, because taking the
   * message for one of them has to clear the keys of all the others. Sharing
   * one Entry object between them is not enough: the map still holds a live
   * key per person, pointing at a message that no longer exists.
   */
  subjects: readonly number[]
  expiresAt: number
}

const keyOf = (chatId: number, userId: number): string => `${chatId}:${userId}`

export class GreetingLog {
  private readonly posted = new Map<string, Entry>()
  private readonly maxTracked: number

  constructor(
    private readonly now: () => number = Date.now,
    options: { maxTracked?: number } = {}
  ) {
    this.maxTracked = options.maxTracked ?? GREETING_MAX_TRACKED
  }

  /**
   * Record a greeting against every person it names.
   *
   * `ttlMs` is the chat's own welcome timer: past it the scheduled deletion has
   * already taken the message, so a later verdict has nothing to retract and
   * should not try. Nothing is stored when the greeting failed to send.
   */
  remember(
    chatId: number,
    userIds: readonly number[],
    messageIds: readonly number[],
    ttlMs: number
  ): void {
    if (messageIds.length === 0 || userIds.length === 0) return
    const entry: Entry = {
      messageIds: [...messageIds],
      subjects: [...userIds],
      expiresAt: this.now() + ttlMs
    }
    for (const userId of userIds) this.posted.set(keyOf(chatId, userId), entry)
    if (this.posted.size > this.maxTracked) this.prune()
  }

  /**
   * The greeting we owe this person, and forget it either way.
   *
   * Read-and-forget because the retraction is one-shot: a delete that Telegram
   * refuses is a statement about our rights in this chat, not something to
   * retry on the sender's next message. Returns null once the greeting's own
   * timer has passed it.
   */
  take(chatId: number, userId: number): RememberedGreeting | null {
    const key = keyOf(chatId, userId)
    const entry = this.posted.get(key)
    if (!entry) return null
    // Every subject, not just the asker: `remember` wrote one key per person
    // and they all point at this one message.
    for (const subject of entry.subjects) this.posted.delete(keyOf(chatId, subject))
    if (entry.expiresAt <= this.now()) return null
    return { messageIds: entry.messageIds, subjects: entry.subjects.length }
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.posted) {
      if (entry.expiresAt <= now) this.posted.delete(key)
    }
    // Still oversized (every greeting is live): drop oldest-inserted first,
    // which Map iteration yields first.
    while (this.posted.size > this.maxTracked) {
      const oldest = this.posted.keys().next().value
      if (oldest === undefined) break
      this.posted.delete(oldest)
    }
  }
}
