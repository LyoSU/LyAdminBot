/**
 * What the chat still shows about somebody's arrival, kept only long enough
 * for a verdict to take it down.
 *
 * Two messages announce a newcomer and neither is about anything they said:
 * Telegram's own service line ("X joined the group"), and — when the chat has
 * welcome on — our greeting of them by name. When the pipeline then removes
 * that person, both are left standing next to the hole where their advert was,
 * reprinting the display name twice over. For an account whose name IS the
 * advert (`promo_in_name`) that undoes part of the removal, and the service
 * line has no timer of its own at all: it stays for good.
 *
 * Memory-only, like `IncidentTracker` and `SenderMessageLog` and for the same
 * reason: it records no judgement, so a restart costs nothing but the tidying.
 * The greeting's persistent scheduled deletion is untouched and remains its
 * backstop — all this does is bring that moment forward.
 */

/** Bounded so a bot in thousands of chats cannot grow this without limit. */
export const ARRIVAL_MAX_TRACKED = 1000

/**
 * How long an arrival stays worth tidying.
 *
 * The greeting deletes itself on the chat's welcome timer (a minute by
 * default), but the service line never does, so the cap is the only thing that
 * would otherwise bound this. A day covers the whole of the join-then-advertise
 * pattern this exists for; past it, deleting the join notice of somebody who
 * had been in the chat for a week is a surprise, not tidying.
 */
export const ARRIVAL_TTL_MS = 24 * 60 * 60 * 1000

export interface ArrivalTrace {
  /** Telegram's own "joined" service message, if we saw it. */
  readonly serviceMessageId: number | null
  /** Our greeting — a gif and its caption are two messages. */
  readonly greetingMessageIds: readonly number[]
  /**
   * How many newcomers these messages name.
   *
   * A bulk add produces ONE service line and ONE greeting for everybody in it,
   * so both are still true about the people we did not remove. The caller
   * decides what to do with that; the count is recorded here because only this
   * side knows it.
   */
  readonly subjects: number
}

interface Entry {
  serviceMessageId: number | null
  greetingMessageIds: readonly number[]
  /**
   * Everyone the messages name — the ids, not a count, because taking them for
   * one person has to clear the keys of all the others. Sharing one Entry
   * object between them is not enough: the map still holds a live key per
   * person, pointing at messages that no longer exist.
   */
  subjects: readonly number[]
  expiresAt: number
}

const keyOf = (chatId: number, userId: number): string => `${chatId}:${userId}`

export class ArrivalLog {
  private readonly posted = new Map<string, Entry>()
  private readonly maxTracked: number
  private readonly ttlMs: number

  constructor(
    private readonly now: () => number = Date.now,
    options: { maxTracked?: number; ttlMs?: number } = {}
  ) {
    this.maxTracked = options.maxTracked ?? ARRIVAL_MAX_TRACKED
    this.ttlMs = options.ttlMs ?? ARRIVAL_TTL_MS
  }

  /**
   * Note the join itself. Called for every arrival, whether or not the chat
   * greets anybody — the service line is Telegram's and exists either way.
   */
  noteJoin(chatId: number, userIds: readonly number[], serviceMessageId: number): void {
    if (userIds.length === 0) return
    const entry: Entry = {
      serviceMessageId,
      greetingMessageIds: [],
      subjects: [...userIds],
      expiresAt: this.now() + this.ttlMs
    }
    for (const userId of userIds) this.posted.set(keyOf(chatId, userId), entry)
    if (this.posted.size > this.maxTracked) this.prune()
  }

  /**
   * Attach our greeting to an arrival already noted.
   *
   * Separate from `noteJoin` because it happens later and conditionally: the
   * send can fail, and most chats have welcome off entirely. Falls back to
   * standing on its own if the join was never noted, so the greeting is still
   * retractable.
   */
  noteGreeting(chatId: number, userIds: readonly number[], messageIds: readonly number[]): void {
    if (userIds.length === 0 || messageIds.length === 0) return
    const first = userIds[0]
    const existing = first === undefined ? undefined : this.posted.get(keyOf(chatId, first))
    const entry: Entry = {
      serviceMessageId: existing?.serviceMessageId ?? null,
      greetingMessageIds: [...messageIds],
      subjects: [...userIds],
      expiresAt: existing?.expiresAt ?? this.now() + this.ttlMs
    }
    for (const userId of userIds) this.posted.set(keyOf(chatId, userId), entry)
    if (this.posted.size > this.maxTracked) this.prune()
  }

  /**
   * What this person's arrival left in the chat, and forget it either way.
   *
   * Read-and-forget because the cleanup is one-shot: a delete that Telegram
   * refuses is a statement about our rights in this chat, not something to
   * retry on the sender's next message.
   */
  take(chatId: number, userId: number): ArrivalTrace | null {
    const key = keyOf(chatId, userId)
    const entry = this.posted.get(key)
    if (!entry) return null
    // Every subject, not just the asker: the writers put one key per person and
    // they all point at these same messages.
    for (const subject of entry.subjects) this.posted.delete(keyOf(chatId, subject))
    if (entry.expiresAt <= this.now()) return null
    return {
      serviceMessageId: entry.serviceMessageId,
      greetingMessageIds: entry.greetingMessageIds,
      subjects: entry.subjects.length
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.posted) {
      if (entry.expiresAt <= now) this.posted.delete(key)
    }
    // Still oversized (every arrival is live): drop oldest-inserted first,
    // which Map iteration yields first.
    while (this.posted.size > this.maxTracked) {
      const oldest = this.posted.keys().next().value
      if (oldest === undefined) break
      this.posted.delete(oldest)
    }
  }
}

/** Every message an arrival left behind, in one list for one delete call. */
export const arrivalMessageIds = (trace: ArrivalTrace): number[] =>
  trace.serviceMessageId === null
    ? [...trace.greetingMessageIds]
    : [trace.serviceMessageId, ...trace.greetingMessageIds]
