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

/** Telegram's ways of saying "there is nothing there to act on". */
const GONE_ERROR_REGEX =
  /USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|USER_ID_INVALID|PEER_ID_INVALID|MESSAGE_ID_INVALID/i

/**
 * What kind of "no" an execution got. Four coarse classes, because they exist
 * to route attention rather than to reproduce Telegram's error list:
 *
 *  - `rights` — the chat never granted this, and only a person can change it.
 *  - `flood` — our own pace; the executor already absorbs waits up to a minute.
 *  - `gone`  — the account left or the message is already deleted. Nothing to do.
 *  - `other` — unrecognised, and named as unrecognised rather than guessed at.
 *
 * Deliberately reuses `RIGHTS_ERROR_REGEX` rather than restating it: that
 * pattern also decides whether a chat gets blocked and nagged, and two
 * definitions of "refused" would eventually disagree about the same string.
 */
export type FailureKind = 'rights' | 'flood' | 'gone' | 'other'

export const failureKind = (error: string): FailureKind => {
  if (RIGHTS_ERROR_REGEX.test(error)) return 'rights'
  if (/FLOOD_WAIT/i.test(error)) return 'flood'
  if (GONE_ERROR_REGEX.test(error)) return 'gone'
  return 'other'
}

/**
 * What a decision row stores about a refused execution: the step, and the kind
 * of refusal. `"ban: CHAT_ADMIN_REQUIRED"` → `"ban:rights"`.
 *
 * Not the message itself. Those are Telegram's own unbounded strings and
 * `pipeline_decisions` is the largest collection in a database that has been up
 * against its quota twice — which is why the row carried the step alone until
 * now. The cost of that showed on 2026-08-26: 306 refused calls in 48 hours,
 * and telling "this chat never granted the right" from "that account had
 * already left" took a second collection and a guess.
 *
 * The step stays FIRST so every query written against the old shape keeps
 * working: `execution.failed` starting with `ban` still means the ban failed.
 */
export const failureLabels = (errors: readonly string[]): string[] =>
  errors.map((e) => `${e.split(':')[0]?.trim() || 'unknown'}:${failureKind(e)}`)

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

/**
 * How long a standing refusal stays the SAME episode.
 *
 * This used to have no constant of its own. The staleness test read
 * `now - probeAt > RIGHTS_PROBE_MAX_MS`, and `probeAt` is not when we last saw
 * a refusal — it is when the next probe becomes due, which `backoffMs` pins to
 * that very same ceiling. Two values derived from one constant, compared
 * against each other: the condition degenerated into "more than about half an
 * hour since the last refusal", which is nothing like the year-old-hiccup case
 * the comment above it described.
 *
 * Measured 2026-08-26 against production. In the worst chat — 291 refusals over
 * eight days, 66 accounts it could not remove — the median gap between refusals
 * is 6.9 minutes, but 46 of 290 gaps exceed sixteen. The counter reset roughly
 * every six refusals and read `1` after all 291, so the nag quiet period swung
 * between an hour and a day at random: the record showed a 24-hour period set
 * at 16:46 and a one-hour period an hour later, for the same unbroken refusal.
 * A quieter chat is worse, not better — one with a median gap of 152 minutes
 * broke the episode on eight of its nine gaps and never left strike one.
 *
 * A day, because what actually ends an episode is a SUCCESS (`forget`) or a
 * granted probe, and neither is a matter of timing. This horizon exists only so
 * a record nobody has touched in a very long time does not resume mid-ladder.
 *
 * Deliberately its own constant even though it currently equals
 * `RIGHTS_WARN_MAX_MS`. Sharing one would restage the bug being fixed here:
 * these answer different questions and are free to move apart.
 */
export const RIGHTS_EPISODE_MS = 24 * 60 * 60 * 1000

/**
 * Ceiling on the accounts remembered per chat, so one record cannot grow
 * without bound. Reached only by a chat refusing hundreds of distinct senders
 * inside a day, where the notice's number is long past the point of persuading
 * anybody — it understates from here, and understating is the safe direction.
 */
const MAX_BLOCKED_ACCOUNTS = 500

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
  /**
   * When we last saw a refusal here (ms epoch); 0 for records written before
   * this field existed, which is read as "no opinion" rather than as "long ago".
   *
   * Separate from `probeAt` on purpose — see `RIGHTS_EPISODE_MS`. `probeAt` is a
   * deadline in the future, this is an observation in the past, and the episode
   * test needs the second one.
   */
  lastRefusalAt: number
  /**
   * Distinct accounts this chat told us to act on and would not let us, within
   * the current episode. The one number that makes the public notice land:
   * "267 refusals" reads as the bot being broken, "66 accounts" reads as the
   * problem it actually is.
   */
  blockedAccounts: number[]
}

/**
 * A record as it comes back from storage, where the two newest fields may not
 * be there yet. Spelled out in the type rather than defended only at runtime:
 * every persisted shape outlives the release that introduced it, and a `restore`
 * that silently accepted a half-record would leave `blockedAccounts` undefined
 * for `push` to trip over on the next refusal.
 */
export type RestoredRights =
  Omit<RightsRecord, 'lastRefusalAt' | 'blockedAccounts'> &
  Partial<Pick<RightsRecord, 'lastRefusalAt' | 'blockedAccounts'>>

/** What a chat is currently missing, for the notice that asks for it. */
export interface RightsGap {
  deleteBlocked: boolean
  senderBlocked: boolean
  /** Distinct accounts left in place this episode; 0 when nothing is recorded. */
  accounts: number
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
    private readonly maxProbeMs: number = RIGHTS_PROBE_MAX_MS,
    private readonly episodeMs: number = RIGHTS_EPISODE_MS
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
  restore(records: readonly RestoredRights[]): void {
    for (const record of records) {
      // Records written before `lastRefusalAt` and `blockedAccounts` existed
      // arrive without them, and every write path below mutates in place.
      this.records.set(record.chatId, {
        ...record,
        lastRefusalAt: Number.isFinite(record.lastRefusalAt) ? record.lastRefusalAt as number : 0,
        blockedAccounts: Array.isArray(record.blockedAccounts) ? [...record.blockedAccounts] : []
      })
    }
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
  noteOutcome(chatId: number, errors: string[], userId?: number): void {
    const refusals = errors.filter((e) => RIGHTS_ERROR_REGEX.test(e))
    if (refusals.length === 0) {
      // Whatever we attempted went through. Forget everything, including blocks
      // on capabilities this particular verdict never exercised: over-clearing
      // costs an evaluation we might not have needed, under-clearing costs
      // moderation nobody notices is missing.
      this.forget(chatId)
      return
    }
    const now = this.now()
    const record = this.records.get(chatId) ?? this.blank(chatId)
    // A refusal a whole day after the last one is a new episode, not the
    // continuation of an old one. Without this, a chat that briefly demoted the
    // bot a year ago would jump straight to the ceiling on its next hiccup.
    //
    // Measured from the last REFUSAL, never from `probeAt`: see
    // `RIGHTS_EPISODE_MS` for what reading the deadline instead did to this.
    // A zero means the record predates the field, and an unknown last refusal
    // is not evidence of a gap — carry the episode rather than invent a break.
    if (record.lastRefusalAt !== 0 && now - record.lastRefusalAt > this.episodeMs) {
      record.strikes = 0
      record.blockedAccounts = []
    }
    record.lastRefusalAt = now
    record.strikes += 1
    record.probeAt = now + this.backoffMs(record.strikes)
    for (const error of refusals) {
      // Everything that is not message removal acts on the sender: kick, mute,
      // ban, and the captcha's restriction.
      if (error.startsWith('delete:')) record.deleteRefused = true
      else record.senderRefused = true
    }
    if (typeof userId === 'number' && Number.isFinite(userId) &&
      record.blockedAccounts.length < MAX_BLOCKED_ACCOUNTS &&
      !record.blockedAccounts.includes(userId)) {
      record.blockedAccounts.push(userId)
    }
    this.save(record)
    this.prune()
  }

  /**
   * What this chat is currently refusing, and how many accounts that has left
   * in place — everything the notice needs to ask for the right thing.
   *
   * A chat with no record answers "both blocked", which is what the manual
   * command paths need: they warn from their own failed attempt without an
   * execution ever reaching `noteOutcome`, so absence of a record there means
   * "we do not know", and the honest ask is for both rights.
   */
  gap(chatId: number): RightsGap {
    const record = this.records.get(chatId)
    if (!record || (!record.deleteRefused && !record.senderRefused)) {
      return { deleteBlocked: true, senderBlocked: true, accounts: 0 }
    }
    return {
      deleteBlocked: record.deleteRefused,
      senderBlocked: record.senderRefused,
      accounts: record.blockedAccounts.length
    }
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
    return {
      chatId, deleteRefused: false, senderRefused: false,
      strikes: 0, probeAt: 0, warnedUntil: 0, lastRefusalAt: 0, blockedAccounts: []
    }
  }

  private save(record: RightsRecord): void {
    this.records.set(record.chatId, record)
    // A snapshot, not the live record. `blockedAccounts` is the first mutable
    // field here and `noteOutcome` pushes into it in place; the store's write
    // is fire-and-forget by contract, so between handing it over and it being
    // serialised this record can change underneath it. Costs one small array
    // copy per refusal, which is a few hundred a day at the worst this has
    // ever seen.
    this.persist(record.chatId, { ...record, blockedAccounts: [...record.blockedAccounts] })
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
