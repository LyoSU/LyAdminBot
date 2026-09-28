/**
 * Which of Telegram's two reports of a join reached us, and which one acts.
 *
 * Until 2026-09-28 a join was known only from its service line ("X joined the
 * group"). A chat can go without one — a large group, one that hides join
 * lines, a join by request — and there the bot learned of the newcomer only
 * when it posted: production on 2026-09-27 banned an account listed that day
 * 24 s after it joined, on its message, although the join-time screen would
 * have banned it at the door.
 *
 * The second report is the member update (`updateChannelParticipant`), which
 * says nothing about the chat's history but arrives whether or not a line is
 * shown. Where both arrive they describe one join, and screening it twice
 * would mean two lookups and, for a listed account, two ban notices. So the
 * first to claim a join acts on it; the member update waits a moment before
 * claiming, because the line carries the message id that the ban reply and the
 * arrival purge need.
 *
 * The tally says how often each report arrived alone. "member only" is the
 * number of joins the bot used to miss; if it stays zero while "line only"
 * does not, Telegram is not sending member updates to this bot at all.
 */

export type JoinReport = 'line' | 'member'

/** How long two reports count as one join. Both usually land within a second. */
export const JOIN_WITNESS_TTL_MS = 10 * 60 * 1000
/** How long the member update gives the line to arrive first. */
export const JOIN_LINE_GRACE_MS = 5 * 1000
/** Bounded so a raid cannot grow this without limit; the oldest are counted and dropped. */
export const JOIN_WITNESS_MAX = 20_000
const TOP_CHATS = 5

interface Witnessed { at: number; line: boolean; member: boolean }

export interface JoinSourcesSummary {
  lineOnly: number
  memberOnly: number
  both: number
  /** Chats with the most member-only joins, as `chatId:count` — the ones that show no line. */
  top: string[]
}

export class JoinWitness {
  private readonly seen = new Map<string, Witnessed>()
  private lineOnly = 0
  private memberOnly = 0
  private both = 0
  private readonly memberOnlyPerChat = new Map<number, number>()

  constructor(
    private readonly ttlMs = JOIN_WITNESS_TTL_MS,
    private readonly max = JOIN_WITNESS_MAX
  ) {}

  /**
   * Note a report of `userId` joining `chatId`. True when this is the first
   * report of that join, and so the one that should record and screen it.
   */
  claim(chatId: number, userId: number, report: JoinReport, now = Date.now()): boolean {
    this.settle(now)
    const key = `${chatId}:${userId}`
    const prior = this.seen.get(key)
    if (prior) {
      prior[report] = true
      return false
    }
    this.seen.set(key, { at: now, line: report === 'line', member: report === 'member' })
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.count(oldest, this.seen.get(oldest)!)
      this.seen.delete(oldest)
    }
    return true
  }

  /** Whether anything settled since the last drain — a quiet hour logs nothing. */
  pending(now = Date.now()): number {
    this.settle(now)
    return this.lineOnly + this.memberOnly + this.both
  }

  /**
   * Report and reset. Only settled joins are counted — one still inside its
   * window may yet be seen the other way, and counting it early would read a
   * slow line as a missing one.
   */
  drain(now = Date.now()): JoinSourcesSummary {
    this.settle(now)
    const top = [...this.memberOnlyPerChat.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_CHATS)
      .map(([chatId, count]) => `${chatId}:${count}`)
    const summary = { lineOnly: this.lineOnly, memberOnly: this.memberOnly, both: this.both, top }
    this.lineOnly = 0
    this.memberOnly = 0
    this.both = 0
    this.memberOnlyPerChat.clear()
    return summary
  }

  /** Count and forget every join whose window has closed. Insertion order is age order. */
  private settle(now: number): void {
    for (const [key, w] of this.seen) {
      if (now - w.at < this.ttlMs) break
      this.count(key, w)
      this.seen.delete(key)
    }
  }

  private count(key: string, w: Witnessed): void {
    if (w.line && w.member) { this.both += 1; return }
    if (w.line) { this.lineOnly += 1; return }
    this.memberOnly += 1
    const chatId = Number(key.slice(0, key.lastIndexOf(':')))
    this.memberOnlyPerChat.set(chatId, (this.memberOnlyPerChat.get(chatId) ?? 0) + 1)
  }
}
