import { telegramErrorName } from './telegram-error.js'

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
/**
 * `step:kind`, and for a refusal of no known kind, `step:WIRE_NAME`.
 *
 * `ban:other` was the whole record for 138 refused bans in the week to
 * 2026-09-01, 124 of them in one chat that was not short of rights — and
 * nothing stored could say what Telegram had actually answered: a peer the
 * session no longer holds, an account Telegram had already deleted, an
 * outage. The wire name (`PEER_ID_INVALID`, `USER_ID_INVALID`) is bounded and
 * carries no text of anybody's, which is the same bar `telegramErrorName`
 * already holds for the vote log. The kinds stay first so `ban:rights` keeps
 * meaning what it meant.
 */
export const failureLabels = (errors: readonly string[]): string[] =>
  errors.map((e) => {
    const step = e.split(':')[0]?.trim() || 'unknown'
    const kind = failureKind(e)
    if (kind !== 'other') return `${step}:${kind}`
    const name = telegramErrorName(e.slice(e.indexOf(':') + 1))
    return `${step}:${name === 'unknown' ? 'other' : name}`
  })

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

/**
 * How long after the first missing-rights notice the one reminder may follow.
 *
 * Production 2026-10-15: the quota this replaces doubled its quiet period with
 * the strike count, but in a chat refusing everything the pipeline stops at the
 * `enforcement_blocked` gate before any execution reaches `noteOutcome`, so the
 * strike count never grew past one and the same chat was asked every hour,
 * indefinitely. A chat-facing notice now follows the STATE instead: once when a
 * chat becomes blocked, one reminder a day later if nothing changed, then
 * silence until the state moves. See `rightsNoticeDecision`.
 */
export const RIGHTS_NOTICE_REMIND_MS = 24 * 60 * 60 * 1000

/** Notices per uninterrupted blocked state: the first one and one reminder. */
export const RIGHTS_NOTICE_MAX = 2

/**
 * How long a record that holds nothing but notice history is kept.
 *
 * Such a record exists for a chat that refused a manual command (/kick, an
 * admin's report) without a pipeline execution ever recording a refusal there.
 * Boot clears records with no refusal once `warnedUntil` has passed, so this is
 * how long those chats stay quiet after their reminder. Not forever: a size-
 * capped cluster must not keep one document per group that once failed a /kick.
 */
export const RIGHTS_NOTICE_KEEP_MS = 30 * 24 * 60 * 60 * 1000

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
  /**
   * Keep this record at least until then (ms epoch), even with nothing refused.
   * Until 2026-10-15 this was the nag quota's deadline; it is now set
   * `RIGHTS_NOTICE_KEEP_MS` past each notice, so the notice history below
   * outlives a boot-time cleanup. The field name stays: the store reads it.
   */
  warnedUntil: number
  /** The rights state the last in-chat notice was about; `none` = never. */
  noticeShape: RightsShape
  /** Notices posted for `noticeShape` so far: 0, 1, or `RIGHTS_NOTICE_MAX`. */
  noticeCount: number
  /** When the last of those notices was posted (ms epoch); 0 = never. */
  noticeAt: number
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
type LateFields = 'lastRefusalAt' | 'blockedAccounts' | 'noticeShape' | 'noticeCount' | 'noticeAt'
export type RestoredRights = Omit<RightsRecord, LateFields> & Partial<Pick<RightsRecord, LateFields>>

/** What a chat is currently missing, for the notice that asks for it. */
export interface RightsGap {
  deleteBlocked: boolean
  senderBlocked: boolean
  /** Distinct accounts left in place this episode; 0 when nothing is recorded. */
  accounts: number
}

/**
 * How often an unchanged refusal may be restated in the log.
 *
 * Production 2026-10-15: `missing_rights` was a WARN written every time the
 * chat-facing notice quota (then `shouldWarn`) opened, which in a chat held at one
 * strike is hourly: the same few chats all day, one of them six times in a
 * night, burying the warnings somebody has to act on. Those chats' admins are
 * deliberately not chased (decision of 2026-10-02), so after the first line
 * there is nothing new for an operator until the state moves. A change is a
 * WARN; an unchanged state is restated once a day at INFO, so a standing block
 * still appears in any day's log.
 */
export const RIGHTS_LOG_REMIND_MS = 24 * 60 * 60 * 1000

/** What a chat refuses us, reduced to the one thing a log line is about. */
export type RightsShape = 'none' | 'delete' | 'sender' | 'all'

export const rightsShape = (deleteRefused: boolean, senderRefused: boolean): RightsShape =>
  deleteRefused && senderRefused ? 'all' : deleteRefused ? 'delete' : senderRefused ? 'sender' : 'none'

/** The last rights state that reached the log for a chat, and when. */
export interface RightsLogMark {
  shape: RightsShape
  at: number
}

/**
 *  - `lost`     — a refusal where the log knew of none: WARN.
 *  - `changed`  — a different set of capabilities is refused now: WARN.
 *  - `restored` — nothing is refused any more, after something was: WARN.
 *  - `still`    — unchanged, and the last line is at least a day old: INFO.
 */
export type RightsLogChange = 'lost' | 'changed' | 'restored' | 'still'

/**
 * Whether a chat's current rights state is worth a log line, and how loud.
 * `null` when it is unchanged and was logged recently, or nothing was ever
 * refused. Pure, so the throttle is tested without a clock, store or logger.
 */
export const rightsLogDecision = (
  prev: RightsLogMark | undefined,
  shape: RightsShape,
  now: number,
  remindMs: number = RIGHTS_LOG_REMIND_MS
): { level: 'warn' | 'info'; change: RightsLogChange } | null => {
  if (shape === 'none') {
    return prev !== undefined && prev.shape !== 'none' ? { level: 'warn', change: 'restored' } : null
  }
  if (prev === undefined || prev.shape === 'none') return { level: 'warn', change: 'lost' }
  if (prev.shape !== shape) return { level: 'warn', change: 'changed' }
  // A clock that went backwards is not a day passing.
  return now - prev.at >= remindMs ? { level: 'info', change: 'still' } : null
}

/**
 * The bot's own membership in a chat, as loosely as the probe needs it: the
 * status, and for an admin the rights bitmask (mtcute's `ChatMember.permissions`,
 * which is null for an admin of a legacy basic group — those hold every right).
 */
export interface BotMembership {
  status: string
  permissions: { deleteMessages?: boolean; banUsers?: boolean } | null
}

/** What the probe found the bot is allowed to do: remove messages, act on senders. */
export interface GrantedRights {
  canDelete: boolean
  canRestrict: boolean
}

/**
 * Read the bot's membership into the two capabilities refusals are recorded
 * against. Pure, so the mapping is tested without Telegram.
 *
 * Until 2026-10-15 the probe read `status` alone, so an admin bot WITHOUT the
 * delete or ban right passed it: the block was forgotten, and every message in
 * that chat paid the full pipeline — the LLM included — until the next refusal
 * re-created it, together with a fresh missing-rights notice. Acting on a sender
 * (kick, mute, ban, the captcha's restriction) needs `banUsers`; removing a
 * message needs `deleteMessages`. Anything unreadable is read as not granted,
 * which leaves a block standing — the safe direction (see `noteProbe`).
 */
export const grantedRights = (member: BotMembership | null | undefined): GrantedRights => {
  if (!member) return { canDelete: false, canRestrict: false }
  if (member.status === 'creator') return { canDelete: true, canRestrict: true }
  if (member.status !== 'admin') return { canDelete: false, canRestrict: false }
  if (member.permissions === null) return { canDelete: true, canRestrict: true }
  return {
    canDelete: member.permissions.deleteMessages === true,
    canRestrict: member.permissions.banUsers === true
  }
}

/** What a probe's answer says is missing, in the shape refusals are logged in. */
export const grantedShape = (granted: GrantedRights): RightsShape =>
  rightsShape(!granted.canDelete, !granted.canRestrict)

/** The last in-chat missing-rights notice: which state it was about, how many, when. */
export interface RightsNoticeMark {
  shape: RightsShape
  count: number
  at: number
}

/**
 *  - `first`       — the chat has just become blocked: post.
 *  - `changed`     — a different set of rights is missing now: post, count anew.
 *  - `reminder`    — unchanged for a day since the only notice: post, last time.
 *  - `not_due`     — one notice so far, less than a day ago: hold.
 *  - `reminded`    — both notices for this state already went out: hold.
 *  - `not_blocked` — nothing is missing, so there is nothing to ask for: hold.
 */
export type RightsNoticeReason = 'first' | 'changed' | 'reminder' | 'not_due' | 'reminded' | 'not_blocked'

/**
 * Whether to post the in-chat missing-rights notice now, and what to remember
 * if it is posted. Pure, so the cadence is tested without a clock or a chat.
 *
 * The cadence is a decision of 2026-10-15: one notice when a chat's rights
 * state becomes blocked, one reminder a day later if it is unchanged, then
 * silence until the state changes. A change between a partial block and a full
 * one counts as a change — the notice asks for a different thing then. Rights
 * restored and lost again restarts the cycle because restoring them deletes the
 * record, and with it this mark.
 *
 * A clock that went backwards is not a day passing.
 */
export const rightsNoticeDecision = (
  prev: RightsNoticeMark,
  shape: RightsShape,
  now: number,
  remindMs: number = RIGHTS_NOTICE_REMIND_MS
): { post: boolean; reason: RightsNoticeReason; next: RightsNoticeMark } => {
  if (shape === 'none') return { post: false, reason: 'not_blocked', next: prev }
  if (prev.count <= 0 || prev.shape === 'none') {
    return { post: true, reason: 'first', next: { shape, count: 1, at: now } }
  }
  if (prev.shape !== shape) return { post: true, reason: 'changed', next: { shape, count: 1, at: now } }
  if (prev.count >= RIGHTS_NOTICE_MAX) return { post: false, reason: 'reminded', next: prev }
  if (now - prev.at >= remindMs) {
    return { post: true, reason: 'reminder', next: { shape, count: prev.count + 1, at: now } }
  }
  return { post: false, reason: 'not_due', next: prev }
}

const NOTICE_SHAPES: readonly RightsShape[] = ['none', 'delete', 'sender', 'all']

const MAX_TRACKED_CHATS = 2000

export class RightsMemory {
  private readonly records = new Map<number, RightsRecord>()

  /**
   * What the log was last told, per chat. Process memory only: `restore` seeds
   * it from the persisted records, so a restart restates nothing, and a lost
   * mark costs at most one extra log line.
   *
   * Deliberately NOT cleared by `forget`. A probe forgets the record on the
   * strength of the rights bitmask alone (since 2026-10-15; admin status alone
   * before that), and where the bitmask and Telegram's answers disagree the next
   * attempt re-creates the same record — clearing the mark there would log
   * "lost" and "restored" on every probe. Only an execution that went through
   * (`noteOutcome` with no refusal) shows up as `restored`.
   */
  private readonly logMarks = new Map<number, RightsLogMark>()

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
      const adopted: RightsRecord = {
        ...record,
        lastRefusalAt: Number.isFinite(record.lastRefusalAt) ? record.lastRefusalAt as number : 0,
        blockedAccounts: Array.isArray(record.blockedAccounts) ? [...record.blockedAccounts] : [],
        noticeShape: NOTICE_SHAPES.includes(record.noticeShape as RightsShape)
          ? record.noticeShape as RightsShape : 'none',
        noticeCount: Number.isFinite(record.noticeCount) ? record.noticeCount as number : 0,
        noticeAt: Number.isFinite(record.noticeAt) ? record.noticeAt as number : 0
      }
      // A record from before 2026-10-15 carries no notice history, but a
      // `warnedUntil` means the chat was asked — in a fully blocked chat, every
      // hour for as long as the block stood. Starting its cycle over would post
      // once more and remind a day later; it has been told enough, so it is
      // read as already reminded about what it is missing now.
      if (adopted.noticeCount === 0 && adopted.warnedUntil > 0) {
        adopted.noticeShape = this.noticeShapeOf(adopted)
        adopted.noticeCount = RIGHTS_NOTICE_MAX
        adopted.noticeAt = this.now()
      }
      this.records.set(record.chatId, adopted)
      // A restart is not a change in anybody's rights: what was known before it
      // was logged then, so the next line here is the daily reminder.
      const shape = rightsShape(record.deleteRefused, record.senderRefused)
      if (shape !== 'none') this.logMarks.set(record.chatId, { shape, at: this.now() })
    }
  }

  /**
   * Whether this chat's current rights state should be logged, and how loudly,
   * remembering the answer so the same state is not logged again. Call after
   * anything that may have changed the state (`noteOutcome`) and wherever a
   * blocked chat is skipped. Two map lookups; safe per message.
   */
  logDecision(chatId: number): { level: 'warn' | 'info'; change: RightsLogChange; shape: RightsShape } | null {
    const record = this.records.get(chatId)
    const shape = record ? rightsShape(record.deleteRefused, record.senderRefused) : 'none'
    const now = this.now()
    const decision = rightsLogDecision(this.logMarks.get(chatId), shape, now)
    if (decision === null) return null
    if (shape === 'none') this.logMarks.delete(chatId)
    else this.logMarks.set(chatId, { shape, at: now })
    if (this.logMarks.size > MAX_TRACKED_CHATS) {
      for (const id of this.logMarks.keys()) if (!this.records.has(id)) this.logMarks.delete(id)
    }
    return { ...decision, shape }
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
   * Record what the cheap lookup said, and return the capabilities it lifted.
   *
   * `granted` may ONLY clear, never create or extend a block — the asymmetry is
   * the whole reason this lookup is allowed to exist. Read pessimistically
   * (the right is missing) it merely leaves that block standing, which is the
   * status quo; read optimistically it costs one evaluation, and the refusal
   * that follows re-blocks the chat. Were it allowed to block on its own, a
   * misread would silence the bot in a healthy chat with nothing in the log.
   *
   * Per capability since 2026-10-15: a right that is present lifts its own
   * block and nothing else, so an admin without the ban right keeps its sender
   * block (and its notice history) instead of being forgotten wholesale.
   */
  noteProbe(chatId: number, granted: GrantedRights): ('delete' | 'sender')[] {
    const record = this.records.get(chatId)
    if (!record) return []
    const lifted: ('delete' | 'sender')[] = []
    if (granted.canDelete && record.deleteRefused) {
      record.deleteRefused = false
      lifted.push('delete')
    }
    if (granted.canRestrict && record.senderRefused) {
      record.senderRefused = false
      lifted.push('sender')
    }
    if (!record.deleteRefused && !record.senderRefused && lifted.length > 0) {
      this.forget(chatId)
      return lifted
    }
    record.probeAt = this.now() + this.backoffMs(record.strikes)
    this.save(record)
    return lifted
  }

  /**
   * Whether to post the missing-rights notice in this chat now, remembering it
   * when the answer is yes. The cadence is `rightsNoticeDecision`; the state it
   * follows is what the notice would ask for (`gap`), so a chat with no record —
   * a manual command refused before any execution — is asked for both rights.
   *
   * Persisted with everything else, because this is the one part of the
   * mechanism the chat can see: the bot restarts several times a day, and a
   * history held in process memory would re-post after each one (as the old
   * quota did three times on 2026-08-07).
   */
  noticeDecision(chatId: number): { post: boolean; reason: RightsNoticeReason; shape: RightsShape; count: number } {
    const now = this.now()
    const existing = this.records.get(chatId)
    const shape = existing ? this.noticeShapeOf(existing) : 'all'
    const prev: RightsNoticeMark = existing
      ? { shape: existing.noticeShape, count: existing.noticeCount, at: existing.noticeAt }
      : { shape: 'none', count: 0, at: 0 }
    const decision = rightsNoticeDecision(prev, shape, now)
    if (decision.post) {
      const record = existing ?? this.blank(chatId)
      record.noticeShape = decision.next.shape
      record.noticeCount = decision.next.count
      record.noticeAt = decision.next.at
      record.warnedUntil = now + RIGHTS_NOTICE_KEEP_MS
      this.save(record)
      this.prune()
    }
    return { post: decision.post, reason: decision.reason, shape, count: decision.next.count }
  }

  /**
   * The rights this chat is KNOWN to be missing, or `null` when no refusal is
   * on record. Unlike `gap`, absence of knowledge is not an ask for both: this
   * feeds a status line, and a status line must not claim what we never saw.
   */
  knownGap(chatId: number): { deleteBlocked: boolean; senderBlocked: boolean } | null {
    const record = this.records.get(chatId)
    if (!record || (!record.deleteRefused && !record.senderRefused)) return null
    return { deleteBlocked: record.deleteRefused, senderBlocked: record.senderRefused }
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
      strikes: 0, probeAt: 0, warnedUntil: 0, lastRefusalAt: 0, blockedAccounts: [],
      noticeShape: 'none', noticeCount: 0, noticeAt: 0
    }
  }

  /** The state a notice is about: what `gap` would ask for. Never `none`. */
  private noticeShapeOf(record: RightsRecord): RightsShape {
    return record.deleteRefused || record.senderRefused
      ? rightsShape(record.deleteRefused, record.senderRefused)
      : 'all'
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
   * is disposable only once no capability is refused and its notice history
   * is past keeping (`warnedUntil`). Storage is left alone — an entry evicted here for space is not an
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
