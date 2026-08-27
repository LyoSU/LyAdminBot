/**
 * What one `getChatMember` call tells us about a person in a chat, cached.
 *
 * Two facts come back from that call and both are used: whether they are an
 * admin, and when Telegram says they joined. The join date used to be thrown
 * away here and fetched again elsewhere — or, in the ballot check, never
 * fetched at all, which is what made a chat the bot had just joined refuse
 * every non-admin voter for a week (2026-08-23). One call, both answers.
 *
 * ── a failure is not an answer ──────────────────────────────────────────
 *
 * The cache this replaces wrote `isAdmin: false` for ten minutes on ANY
 * exception, a timeout and a dropped connection included. So a single failed
 * RPC took an admin's authority away from them — the vote, the undo button,
 * every admin-only command — for ten minutes, silently, and looked exactly
 * like a permissions problem to the person it happened to.
 *
 * A refusal that names the person ("there is no such member here") IS an
 * answer, stable until somebody joins, and is cached — otherwise every tap
 * from a non-member costs an RPC, and a tap-loop would spend our rate limit
 * for us. Anything else is a failure: answer "not an admin" for this tap,
 * because granting authority on a failed check is the worse mistake, but write
 * nothing down, so the very next tap asks again.
 */

/** How long an answer stands before it is asked for again. */
export const MEMBER_FACTS_TTL_MS = 10 * 60 * 1000

/**
 * Telegram's ways of saying "there is no such member here". Matched on the
 * message text, the same way `RIGHTS_ERROR_REGEX` reads refusals: the wire
 * error is what we actually have, and it survives client versions better than
 * any class does.
 */
export const NO_SUCH_MEMBER_REGEX =
  /USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|USER_ID_INVALID/i

/** Entries kept before stale ones are swept — a bot lives for weeks. */
const SWEEP_ABOVE = 10_000

export interface MemberFacts {
  isAdmin: boolean
  /** Seconds since Telegram says they joined; null when it did not say. */
  joinedAgoSeconds: number | null
  /**
   * Whether Telegram says this person is in the chat at all.
   *
   * `false` when it ANSWERED and the answer names nobody. That is two shapes,
   * not one: the refusals `NO_SUCH_MEMBER_REGEX` matches, and — the shape
   * production actually produces — an empty answer, because mtcute 0.31 catches
   * `USER_NOT_PARTICIPANT` inside `getChatMember` and returns `null` for it.
   * Read as "unknown" until 2026-08-27, that null made the whole guard
   * unreachable: `mayAskCaptcha` permits null, so every non-member commenter was
   * still asked a question that can only be delivered to a member.
   *
   * `null` is reserved for a lookup that did not answer at all: a timeout, a
   * dropped connection. The distinction is the same one the
   * cache already makes about what is worth writing down, and it was being
   * computed and discarded.
   *
   * A commenter under a channel post is frequently not a member of the linked
   * discussion group, and the captcha's only delivery — a whisper — requires
   * membership. So this is what tells the pipeline not to ask a question it
   * cannot deliver.
   */
  isParticipant: boolean | null
}

/** The shape we read out of `getChatMember`, as loosely as it is worth reading. */
export type MemberAnswer = { status?: unknown; joinedDate?: unknown } | null | undefined

const NOT_AN_ADMIN: MemberFacts = { isAdmin: false, joinedAgoSeconds: null, isParticipant: null }

/** Telegram answered, and the answer names nobody. */
const NOT_A_MEMBER: MemberFacts = { isAdmin: false, joinedAgoSeconds: null, isParticipant: false }

const timestampMs = (at: unknown): number | null => {
  if (typeof at !== 'string' && typeof at !== 'number' && !(at instanceof Date)) return null
  const ms = new Date(at).getTime()
  return Number.isFinite(ms) ? ms : null
}

export class MemberFactsCache {
  private readonly entries = new Map<string, { facts: MemberFacts; expiresMs: number }>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = MEMBER_FACTS_TTL_MS
  ) {}

  /** How many answers are being held — for the sweep, and for tests. */
  get size(): number { return this.entries.size }

  /**
   * What we already know, without asking Telegram — null when we do not know.
   *
   * "Unknown" and "not an admin" are different answers and the caller has to be
   * able to tell them apart, which is why this is not a boolean.
   */
  peek(chatId: number, userId: number): MemberFacts | null {
    const cached = this.entries.get(`${chatId}:${userId}`)
    return cached && cached.expiresMs > this.now() ? cached.facts : null
  }

  async get(
    chatId: number, userId: number, lookup: () => Promise<MemberAnswer>
  ): Promise<MemberFacts> {
    const key = `${chatId}:${userId}`
    const cached = this.entries.get(key)
    if (cached && cached.expiresMs > this.now()) return cached.facts

    let facts: MemberFacts
    try {
      facts = this.read(await lookup())
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      // Not an answer about this person — do not write anything down.
      if (!NO_SUCH_MEMBER_REGEX.test(text)) return NOT_AN_ADMIN
      facts = NOT_A_MEMBER
    }

    if (this.entries.size >= SWEEP_ABOVE) this.sweep()
    this.entries.set(key, { facts, expiresMs: this.now() + this.ttlMs })
    return facts
  }

  private read(member: MemberAnswer): MemberFacts {
    // An empty answer IS an answer here — see `isParticipant`. It is the shape
    // mtcute hands back for `USER_NOT_PARTICIPANT`, and the shape a basic group
    // gives for somebody absent from its participant list.
    if (!member) return NOT_A_MEMBER
    const joinedMs = timestampMs(member.joinedDate)
    return {
      isAdmin: member.status === 'admin' || member.status === 'creator',
      isParticipant: true,
      // Clamped: a join date in the future is a clock disagreement, not
      // negative tenure, and negative tenure would read as "brand new".
      joinedAgoSeconds: joinedMs === null ? null : Math.max(0, (this.now() - joinedMs) / 1000)
    }
  }

  private sweep(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresMs <= now) this.entries.delete(key)
    }
  }
}
