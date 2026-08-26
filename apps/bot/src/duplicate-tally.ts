/**
 * How many redeliveries the gateway dropped, and in which chats.
 *
 * The gateway has reported every dropped duplicate since it learned to drop
 * them, and the app has listened since the same day — at `log.debug`, which
 * production never emits (`LOG_LEVEL` defaults to `info`). So the number was
 * computed, handed over, and discarded one step further along than anybody
 * looked: on 2026-08-26 the question "is the dedup firing at all" could not be
 * answered from any record, while 19% of pipeline runs were re-evaluations of
 * a message already judged.
 *
 * The per-event line stays at debug on purpose — the gateway's own comment is
 * right that one redelivery is the transport working as specified. What was
 * missing is the shape: a total, and WHICH chats, which is the half that
 * separates "the transport hiccups evenly everywhere" from "one chat is
 * arriving twice". Production 2026-08-26 measured re-evaluation rates from
 * 0.9% to 57.5% across chats, and no uniform cause explains that spread.
 *
 * Bounded by construction: one integer per chat seen since the last drain, and
 * the drain empties it.
 */
export interface DuplicateSummary {
  /** Redeliveries dropped since the last drain. */
  total: number
  /** Distinct chats they arrived in. */
  chats: number
  /** The busiest chats, worst first, as `chatId:count`. */
  top: string[]
}

/** How many chats the summary names. Enough to see a shape, short enough to read. */
const TOP_CHATS = 10

export class DuplicateTally {
  private readonly perChat = new Map<number, number>()
  private total = 0

  note(chatId: number): void {
    this.total += 1
    this.perChat.set(chatId, (this.perChat.get(chatId) ?? 0) + 1)
  }

  /** Whether anything happened worth saying — a quiet hour logs nothing. */
  get pending(): number { return this.total }

  /** Report and reset. Reporting a window twice would read as a rising rate. */
  drain(): DuplicateSummary {
    const top = [...this.perChat.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_CHATS)
      .map(([chatId, count]) => `${chatId}:${count}`)
    const summary = { total: this.total, chats: this.perChat.size, top }
    this.perChat.clear()
    this.total = 0
    return summary
  }
}
