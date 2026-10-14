/**
 * Bookkeeping for the join-request shadow (2026-10-14) — see
 * `packages/core/src/join-request.ts` for what is measured and why.
 *
 * Two things, both in memory and both bounded, because a raid of join requests
 * is exactly the case this exists to see and must not turn into a stall:
 *
 *  - `JoinRequestLedger`: one row per (chat, account) per hour. A person who
 *    re-taps "request to join", or a client that resends, is one requester, and
 *    a decision row per tap would inflate the very count we want. It also holds
 *    the answer until the account actually arrives, so the arrival row can be
 *    stamped with it — the request is usually approved by a human minutes or
 *    hours later, and that join is the outcome the answer is judged against.
 *  - `createScreenLimiter`: the full read costs a profile fetch (several
 *    Telegram calls), an avatar download and an external-ban lookup. Those share
 *    the client and its flood limits with moderation, so they run a few at a
 *    time and anything past a short queue gets the cached read instead.
 *
 * A deploy drops both, which costs the measurement a little and moderation
 * nothing.
 */

/** Repeated requests from one account to one chat inside this are one request. */
export const JOIN_REQUEST_DEDUP_MS = 60 * 60 * 1000
/**
 * How long an answer waits for its arrival. Requests can sit unanswered for
 * days; past two, the decision row (14-day TTL) is still there to join on by
 * (chatId, userId) — this stamp is a convenience, not the only link.
 */
export const JOIN_REQUEST_STAMP_MS = 2 * 24 * 60 * 60 * 1000
export const JOIN_REQUEST_TRACKED_MAX = 5000

export interface JoinRequestStamp {
  wouldDecide: string
  reason: string
  at: Date
}

interface Entry { claimedAt: number; stamp: JoinRequestStamp | null }

export class JoinRequestLedger {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: { dedupMs?: number; stampMs?: number; maxTracked?: number } = {}
  ) {}

  private key(chatId: number, userId: number): string { return `${chatId}:${userId}` }

  /** True for the first request in the window — the one to screen and record. */
  claim(chatId: number, userId: number): boolean {
    const key = this.key(chatId, userId)
    const at = this.now()
    const prior = this.entries.get(key)
    if (prior && at - prior.claimedAt < (this.options.dedupMs ?? JOIN_REQUEST_DEDUP_MS)) return false
    this.entries.delete(key)
    this.entries.set(key, { claimedAt: at, stamp: null })
    const max = this.options.maxTracked ?? JOIN_REQUEST_TRACKED_MAX
    // Insertion order is age order (a re-claim re-inserts), so the head is the oldest.
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return true
  }

  /** The answer for a claimed request; ignored when the claim is gone. */
  remember(chatId: number, userId: number, stamp: JoinRequestStamp): void {
    const entry = this.entries.get(this.key(chatId, userId))
    if (entry) entry.stamp = stamp
  }

  /**
   * The answer for an account arriving now, once — a second arrival of the same
   * account is a rejoin, not the outcome of this request.
   */
  take(chatId: number, userId: number): JoinRequestStamp | null {
    const key = this.key(chatId, userId)
    const entry = this.entries.get(key)
    if (!entry?.stamp) return null
    this.entries.delete(key)
    if (this.now() - entry.stamp.at.getTime() > (this.options.stampMs ?? JOIN_REQUEST_STAMP_MS)) return null
    return entry.stamp
  }

  get size(): number { return this.entries.size }
}

/** Full reads in flight at once. */
export const JOIN_REQUEST_SCREEN_CONCURRENCY = 2
/** Full reads waiting; one more goes to the cached read. */
export const JOIN_REQUEST_SCREEN_QUEUE_MAX = 20

export interface ScreenLimiter {
  /** Runs `task` when a slot frees; null, without running it, when the queue is full. */
  submit<T>(task: () => Promise<T>): Promise<T> | null
  readonly active: number
  readonly queued: number
}

export const createScreenLimiter = (options: {
  concurrency?: number
  maxQueued?: number
} = {}): ScreenLimiter => {
  const concurrency = options.concurrency ?? JOIN_REQUEST_SCREEN_CONCURRENCY
  const maxQueued = options.maxQueued ?? JOIN_REQUEST_SCREEN_QUEUE_MAX
  let active = 0
  const waiting: (() => void)[] = []
  const release = (): void => {
    active -= 1
    const next = waiting.shift()
    if (next) next()
  }
  return {
    submit<T>(task: () => Promise<T>): Promise<T> | null {
      if (active >= concurrency && waiting.length >= maxQueued) return null
      return new Promise<T>((resolve, reject) => {
        const start = (): void => {
          active += 1
          // Through a resolved promise so a task that throws synchronously still
          // releases its slot.
          Promise.resolve().then(task).then(resolve, reject).finally(release)
        }
        if (active < concurrency) start()
        else waiting.push(start)
      })
    },
    get active() { return active },
    get queued() { return waiting.length }
  }
}
