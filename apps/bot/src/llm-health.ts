/**
 * Is the classifier reachable — as distinct from right.
 *
 * The failure hook fires per message, and that is correct for diagnosis and
 * wrong for noticing. 2026-08-07 produced two incidents that read identically in
 * the log, one `llm_unanswered` warning per message, and were not the same
 * event at all:
 *
 *  - a routing conflict: EVERY call 404'd for an hour. The classifier was gone,
 *    and nothing said so louder than it says a single skipped message.
 *  - a truncation bug: SOME calls 400'd, interleaved with verdicts. Chats whose
 *    prompts fell on an even boundary were judged normally throughout.
 *
 * Hence consecutive, not a rate: consecutive failures are the shape of "nothing
 * is coming back", while scattered ones are the shape of "we are asking it
 * something malformed". Only the first is an outage, and only the first deserves
 * to interrupt anybody.
 *
 * "Nothing is coming back" rather than "unreachable" on purpose. A provider that
 * answers 200 with a verdict that fails the schema counts here exactly like one
 * that refuses the connection, because the consequence is identical: grey-zone
 * messages go unjudged. The `reason` carried into the log says which it was; the
 * decision to shout does not depend on knowing.
 *
 * Two rules make the counting mean what it says:
 *
 *  - Only LIVE calls count. A cache hit answers the message without touching the
 *    API, so counting it as health would report recovery during an outage.
 *  - Nothing here awaits. Message handlers interleave at every `await`, so the
 *    increment and the threshold test have to be one uninterrupted step — and
 *    the test is `=== STREAK`, not `>=`, so exactly one call observes the
 *    crossing however many are in flight. That is the whole of the atomicity
 *    this needs; it is not a lock, it is the absence of a suspension point.
 */

/**
 * Consecutive live failures that mean the classifier is unreachable rather than
 * unlucky. At grey-zone volume (~25 live calls an hour in production) five is a
 * few minutes — short enough to catch an outage while it is still happening,
 * long enough that one rate limit or one malformed prompt says nothing.
 */
export const LLM_OUTAGE_STREAK = 5

/**
 * How often to say it again while it is still down. One line at the start of a
 * six-hour outage that began overnight is a line nobody sees; one per message is
 * what this exists to remove. Hourly is the smallest honest trail.
 */
export const LLM_OUTAGE_REPEAT_MS = 60 * 60 * 1000

/** What the caller should log, or `null` for "nothing worth saying". */
export type HealthReport =
  | { kind: 'down'; consecutive: number; repeated: boolean }
  | { kind: 'recovered'; missed: number }
  | null

export class LlmHealth {
  private consecutive = 0
  /** When the outage was last reported; 0 while no outage stands. */
  private reportedAt = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** A live call produced no verdict. */
  noteFailure(): HealthReport {
    this.consecutive += 1
    if (this.consecutive === LLM_OUTAGE_STREAK) {
      this.reportedAt = this.now()
      return { kind: 'down', consecutive: this.consecutive, repeated: false }
    }
    if (this.reportedAt !== 0 && this.now() - this.reportedAt >= LLM_OUTAGE_REPEAT_MS) {
      this.reportedAt = this.now()
      return { kind: 'down', consecutive: this.consecutive, repeated: true }
    }
    return null
  }

  /** A live call answered. */
  noteAnswer(): HealthReport {
    const missed = this.consecutive
    const wasDown = this.reportedAt !== 0
    this.consecutive = 0
    this.reportedAt = 0
    // A streak that never crossed the threshold was never announced, so its
    // recovery is not news either. Silence in, silence out.
    return wasDown ? { kind: 'recovered', missed } : null
  }

  /** For `/ping` and anything else that wants to say it out loud. */
  get failing(): number {
    return this.consecutive
  }
}
