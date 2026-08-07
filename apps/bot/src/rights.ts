/**
 * What Telegram has recently refused us, per chat.
 *
 * Production, 2026-07-30: five of six verdicts inside one hour could not be
 * applied — four chats where the bot is not an admin, or is one without the
 * relevant right. Detection kept running at full price (LLM calls of 2-5s per
 * message) and achieved nothing in those chats.
 *
 * Design notes, because getting this wrong is worse than the waste it saves:
 *
 *  - A *failed attempt* is the only thing that may CREATE a block. Deciding to
 *    stand down from a rights lookup risks the opposite mistake — going quiet in
 *    a healthy chat, the invisible no-op this codebase has been burned by
 *    before. A lookup may only LIFT a block; see `mayProbe`.
 *  - Blocks are per capability. A chat where `delete` works and `ban` does not
 *    is still very much worth moderating.
 *  - Rights granted later resume moderation without a restart and without
 *    anybody having to notice.
 *
 * A flat block turned out to be the wrong shape (production 2026-08-01). One
 * chat refused every action for a hundred minutes while an advert was reposted
 * on a roughly quarter-hourly cadence — just slower than the block, so each
 * repost landed a minute or two after the block lapsed and paid the full price
 * again: six enrichments, six vector searches, six moderation calls, six
 * verdicts, nothing enforced. The retry has to grow while the refusal persists,
 * and collapse the moment anything succeeds.
 *
 * ── the fact and the timer are two things (2026-08-07) ──────────────────
 *
 * They used to be one: a block WAS an expiry, so when the expiry passed the
 * refusal was forgotten and the next message paid the full pipeline to
 * rediscover it. Two consequences, both visible in production the same day:
 *
 *  - This state lived only in process memory, so a restart erased it. The bot
 *    restarted three times on 2026-08-07; each time, every chat that had
 *    refused it — one of them already at `blocked: true` sixteen minutes
 *    earlier — paid a full evaluation again to learn what was already known.
 *  - "The bot is not an admin here" is not a temporary condition. It changes
 *    when a human changes it, which is exactly what an expiry cannot express.
 *
 * So the refusal is a FACT (`deleteRefused` / `senderRefused`), persisted, with
 * no expiry; and the timer is only about how often we may re-ask. Re-asking is
 * now a single cheap membership lookup instead of an entire pipeline, which
 * makes it affordable often — so the ceiling on the backoff went DOWN from two
 * hours to fifteen minutes. Cheaper and more responsive at once.
 */

/** Telegram's ways of saying "you may not do that here". */
export const RIGHTS_ERROR_REGEX = /ADMIN_REQUIRED|FORBIDDEN|not enough rights|RIGHT/i

/** How soon after a refusal the cheap capability lookup may run. */
export const RIGHTS_PROBE_MS = 60 * 1000

/**
 * Ceiling on the doubling, and therefore the longest an admin can wait after
 * granting rights before moderation resumes by itself.
 *
 * Fifteen minutes, where the old full-pipeline retry had to wait two hours: the
 * quantity being rate-limited is one `getChatMember` call, so a chat that
 * refuses us all day costs a few dozen cheap lookups instead of a handful of
 * evaluations. The ceiling exists to bound noise, not cost.
 */
export const RIGHTS_PROBE_MAX_MS = 15 * 60 * 1000

/** First quiet period after asking a chat's admins for rights. */
export const RIGHTS_WARN_MS = 60 * 60 * 1000

/** Ceiling on the nag quiet period: once a day into a chat that ignores it. */
export const RIGHTS_WARN_MAX_MS = 24 * 60 * 60 * 1000

export interface RightsRecord {
  chatId: number
  /** Telegram refused to remove a MESSAGE here. A fact, not a deadline. */
  deleteRefused: boolean
  /** Telegram refused to act on the SENDER here (kick/mute/ban/restrict). */
  senderRefused: boolean
  /** Consecutive executions refused. Drives both backoffs. */
  strikes: number
  /** Not before this (ms epoch): when the cheap lookup may run again. */
  probeAt: number
  /** Not before this (ms epoch): when the admins may be asked again. */
  warnedUntil: number
}

const MAX_TRACKED_CHATS = 2000

export class RightsMemory {
  private readonly records = new Map<number, RightsRecord>()

  /**
   * @param now injectable clock, for the tests
   * @param persist called with every changed record, and with `null` when a
   *   chat is forgotten. Fire-and-forget by contract: this class must never
   *   wait on storage, because it sits in front of the hot path. Losing a write
   *   costs one evaluation, which is what the whole mechanism is trying to save
   *   — not a correctness problem.
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly persist: (chatId: number, record: RightsRecord | null) => void = () => { /* memory only */ },
    private readonly probeMs: number = RIGHTS_PROBE_MS,
    private readonly maxProbeMs: number = RIGHTS_PROBE_MAX_MS
  ) {}

  /**
   * Adopt persisted records at startup.
   *
   * Deliberately no adjustment of `probeAt` on the way in. It was tempting to
   * shorten a restored timer so a restart doubles as a chance to re-check — but
   * a restart is evidence about our own code, not about anybody's rights, and
   * the cheap lookup already re-checks within fifteen minutes at worst. Trimming
   * it would only reintroduce the cost this persistence exists to remove.
   */
  restore(records: RightsRecord[]): void {
    for (const record of records) this.records.set(record.chatId, record)
  }

  /**
   * Record what an execution proves. `errors` are the executor's
   * `${label}: ${message}` strings; only rights refusals count, and only the
   * capability that was actually refused.
   *
   * The success branch is why this is one method and not two. An execution that
   * raised no rights refusal is the only positive evidence we ever get, and a
   * backoff that can grow but never shrink would eventually stand the bot down
   * in a chat that had long since promoted it. Forgetting to call a separate
   * `noteSuccess` would fail silently and only in production, which is the
   * failure mode this file exists to avoid.
   */
  noteOutcome(chatId: number, errors: string[]): void {
    const refusals = errors.filter((e) => RIGHTS_ERROR_REGEX.test(e))
    if (refusals.length === 0) {
      // Whatever we attempted went through. Forget everything, including blocks
      // on capabilities this particular verdict never exercised: over-clearing
      // costs an evaluation we might not have needed, under-clearing costs
      // moderation nobody notices is missing.
      this.forget(chatId)
      return
    }
    const record = this.records.get(chatId) ?? this.blank(chatId)
    // A refusal long after the last probe was due is a new episode, not the
    // continuation of an old one. Without this, a chat that briefly demoted the
    // bot a year ago would jump straight to the ceiling on its next hiccup.
    if (this.now() - record.probeAt > this.maxProbeMs) record.strikes = 0
    record.strikes += 1
    record.probeAt = this.now() + this.backoffMs(record.strikes)
    for (const error of refusals) {
      // Everything that is not message removal acts on the sender: kick, mute,
      // ban, and the captcha's restriction.
      if (error.startsWith('delete:')) record.deleteRefused = true
      else record.senderRefused = true
    }
    this.save(record)
    this.prune()
  }

  /**
   * True when BOTH removing messages and acting on senders have been refused
   * here and nothing has since proved otherwise. Nothing a verdict could
   * conclude is actionable in that state, so the paid stages are not worth
   * running.
   *
   * No clock: this answers "what do we know", and knowledge does not lapse.
   * When to go and look again is `mayProbe`.
   */
  cannotEnforce(chatId: number): boolean {
    const record = this.records.get(chatId)
    return record !== undefined && record.deleteRefused && record.senderRefused
  }

  /** Whether the cheap capability lookup is due for this chat. */
  mayProbe(chatId: number): boolean {
    const record = this.records.get(chatId)
    return record === undefined || record.probeAt <= this.now()
  }

  /**
   * Record what the cheap lookup said.
   *
   * `granted` may ONLY clear, never create or extend a block — the asymmetry is
   * the whole reason this lookup is allowed to exist. Read pessimistically
   * (we are not an admin) it merely leaves the block standing, which is the
   * status quo; read optimistically it costs one evaluation, and the refusal
   * that follows re-blocks the chat. Were it allowed to block on its own, a
   * misread would silence the bot in a healthy chat with nothing in the log.
   */
  noteProbe(chatId: number, granted: boolean): void {
    if (granted) {
      this.forget(chatId)
      return
    }
    const record = this.records.get(chatId)
    if (!record) return
    record.probeAt = this.now() + this.backoffMs(record.strikes)
    this.save(record)
  }

  /**
   * Whether to ask this chat's admins for rights now, and remember that we did.
   *
   * Persisted with everything else, because this is the one part of the
   * mechanism the chat can see. The quiet period doubles from an hour to a day
   * with the strike count, and both used to live in process memory: after each
   * of the three restarts on 2026-08-07 the quota fell back to the first hour
   * and the same chats were asked again.
   */
  shouldWarn(chatId: number): boolean {
    const now = this.now()
    const record = this.records.get(chatId) ?? this.blank(chatId)
    if (record.warnedUntil > now) return false
    record.warnedUntil = now + Math.min(
      RIGHTS_WARN_MS * 2 ** Math.max(0, record.strikes - 1),
      RIGHTS_WARN_MAX_MS
    )
    this.save(record)
    return true
  }

  /**
   * How many consecutive executions this chat has refused. Zero once anything
   * succeeds.
   */
  strikes(chatId: number): number {
    return this.records.get(chatId)?.strikes ?? 0
  }

  /** Chats currently refusing us something — for operational reporting. */
  blockedChats(): { chatId: number; deleteBlocked: boolean; senderBlocked: boolean }[] {
    const out: { chatId: number; deleteBlocked: boolean; senderBlocked: boolean }[] = []
    for (const record of this.records.values()) {
      if (record.deleteRefused || record.senderRefused) {
        out.push({
          chatId: record.chatId,
          deleteBlocked: record.deleteRefused,
          senderBlocked: record.senderRefused
        })
      }
    }
    return out
  }

  private blank(chatId: number): RightsRecord {
    return { chatId, deleteRefused: false, senderRefused: false, strikes: 0, probeAt: 0, warnedUntil: 0 }
  }

  private save(record: RightsRecord): void {
    this.records.set(record.chatId, record)
    this.persist(record.chatId, record)
  }

  private forget(chatId: number): void {
    if (!this.records.delete(chatId)) return
    // Only when something was actually there: the success path runs after every
    // applied verdict, and a delete-per-message against storage would be the
    // wasteful write this class exists to avoid.
    this.persist(chatId, null)
  }

  private backoffMs(strikes: number): number {
    return Math.min(this.probeMs * 2 ** Math.max(0, strikes - 1), this.maxProbeMs)
  }

  /**
   * Bound the map. Nothing is dropped while it still says something: a record
   * is disposable only once no capability is refused and the nag quota has
   * lapsed. Storage is left alone — an entry evicted here for space is not an
   * entry we learned anything new about.
   */
  private prune(): void {
    if (this.records.size <= MAX_TRACKED_CHATS) return
    const now = this.now()
    for (const [chatId, record] of this.records) {
      const spent = !record.deleteRefused && !record.senderRefused && record.warnedUntil <= now
      if (spent) this.records.delete(chatId)
    }
  }
}
