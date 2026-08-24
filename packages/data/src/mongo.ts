/**
 * Mongo store: same database and collections as v1 (byte-compatible,
 * additive-only). New collections introduced by v2:
 *   pipeline_decisions — every verdict, TTL 14d (replay + calibration)
 *   pipeline_feedback  — admin overrides, permanent (ham labels)
 *   llm_cache          — LLM verdict cache, TTL 7d
 */
import { MongoClient, ObjectId, type Collection, type Db, type Document } from 'mongodb'
import type { BurstEntry, EditBaseline, ExecutionRecord, Verdict, Signal } from '@lyadmin/core'
import { truncate, VOTE_WINDOW_SECONDS } from '@lyadmin/core'
import { normalizeExtra, type NormalizedExtra } from './extras.js'
import { VELOCITY_WINDOW_MS, SESSION_WINDOW_MS, BURST_WINDOW_MS } from './persistent-ports.js'
import {
  addWelcomeItem, removeAt, type AddReason,
  MAX_WELCOME_TEXTS, MAX_WELCOME_GIFS, MAX_WELCOME_TEXT_LEN
} from './welcome.js'

// 14d is the free-tier (Atlas M0, 512 MB) sustainable ceiling: at the observed
// write rate 90d retention refills the cluster past quota and blocks writes.
const DECISIONS_TTL_DAYS = 14
const LLM_CACHE_TTL_DAYS = 7

/**
 * How long a trace-free record is kept before `pruneDormantRecords` drops it.
 *
 * Six months, deliberately far beyond what any signal reads. Nothing consults a
 * counter this small, so the number is not protecting a threshold — it is
 * protecting against being wrong about that, which the 2026-07-06 cleanup was.
 */
const DORMANT_DAYS = 180
/** Per-call ceiling: a sweep on a shared-tier cluster must never be a long one. */
const PRUNE_BATCH = 5000

/**
 * Who `pruneDormantRecords` may remove, as two filters.
 *
 * Exported so the catch-up tool can COUNT with them before it deletes with
 * them. A dry run that restates the query in its own words is worse than none:
 * it would report on a set the deletion does not use, and the report would be
 * believed. See `pruneDormantRecords` for why each clause is here.
 */
export const dormantFilters = (now = Date.now()): { members: Document; users: Document } => {
  const cutoff = new Date(now - DORMANT_DAYS * 86400 * 1000)
  return {
    // `$not: { $gt: 0 }` rather than `$lte: 0`, throughout: the field is absent
    // on most of these documents, and `$lte` does not match a missing field.
    // Written the other way this would have quietly pruned nothing at all.
    members: {
      'stats.messagesCount': { $lte: 1 },
      'stats.spamMessages': { $not: { $gt: 0 } },
      'banan.num': { $not: { $gt: 0 } },
      // `$in: [0, null]`, not `$not: { $ne: 0 }`. The second reads as "score is
      // zero" but Mongo compares a MISSING field as not-equal-to-zero, so it
      // spared every document that never had the field — which is most of them.
      // `$in` with a null in the list is the form that matches absent as well.
      score: { $in: [0, null] },
      // Two clocks, as on the users half and for the same reason. `touchMember`
      // now stamps `updatedAt` on every message, but it only started doing so on
      // 2026-08-24 and it can only stamp a row somebody comes back to: 33567 rows
      // written before that date carry no `updatedAt` at all, and a member who
      // posted once in the v2 era and never returned would never acquire one.
      // Mongo does not match a missing field against `$lt`, so those rows would
      // have sat outside the sweep for ever — the same defect the `updatedAt`
      // write was fixing, surviving in the population it could not reach.
      // `stats.firstMessageAt` is set on insert and every one of those rows has it.
      $or: [
        { updatedAt: { $lt: cutoff } },
        { updatedAt: { $exists: false }, 'stats.firstMessageAt': { $lt: cutoff } }
      ]
    },
    users: {
      'globalStats.totalMessages': { $lte: 1 },
      'globalStats.spamDetections': { $not: { $gt: 0 } },
      // Anybody's verdict on the account is a reason to remember it, including
      // the cached "not listed" answers — those cost two HTTP calls to rebuild.
      'reputation.status': { $not: { $in: ['suspicious', 'restricted', 'trusted'] } },
      'externalBan.cas.banned': { $ne: true },
      'externalBan.lols.banned': { $ne: true },
      isGlobalBanned: { $ne: true },
      // Being in more than one of our chats is itself a history. `many_shared_chats`
      // reads exactly this counter, and reads it for accounts with almost no
      // messages — which is the population every other clause here selects — so
      // without this the sweep would delete the only records that signal can fire
      // on. The bar is one chat rather than the signal's five: the point is to
      // keep anything a reader might want, not to match a threshold that could
      // move.
      'globalStats.groupsActive': { $not: { $gt: 1 } },
      // v1 wrote `lastActive`; documents v2 created carry only `firstSeen`, and
      // for an account with one message to its name the two mean the same thing.
      $or: [
        { 'globalStats.lastActive': { $lt: cutoff } },
        { 'globalStats.lastActive': { $exists: false }, 'globalStats.firstSeen': { $lt: cutoff } }
      ]
    }
  }
}

/**
 * One chat's standing refusal, as stored. Structurally the bot's own
 * `RightsRecord` — declared here rather than imported because the store cannot
 * depend on the app, and kept a plain data shape so it stays that way.
 */
export interface RightsBlockRecord {
  chatId: number
  deleteRefused: boolean
  senderRefused: boolean
  strikes: number
  probeAt: number
  warnedUntil: number
}

/**
 * MongoDB's error code for a namespace that does not exist. `listIndexes` on a
 * collection nothing has ever written to raises it; `createIndex` instead
 * creates the collection implicitly.
 */
const NAMESPACE_NOT_FOUND = 26

/**
 * What a member's traffic in one chat earns them: messages written, less the
 * ones the pipeline judged to be spam.
 *
 * One definition, because two readers need it — `touchMember`, which hands it
 * to the pipeline as prior standing, and `getMemberStats`, which hands it to
 * the ballot bar. They must not be able to disagree about what a message is
 * worth. Never negative: the two counters are moved by separate writers and a
 * negative standing would read as worse than a stranger's.
 */
const standingFrom = (stats: { messagesCount?: number; spamMessages?: number } | undefined): number =>
  Math.max(0, (stats?.messagesCount ?? 0) - (stats?.spamMessages ?? 0))

/**
 * Create a TTL index, tolerating an already-present index on the same key with
 * a *different* expiry. `createIndex` is not an upsert: re-issuing it with a
 * changed expireAfterSeconds throws IndexOptionsConflict. The clean fix
 * (`collMod`) is blocked on shared Atlas tiers (M0), so the only way to retune
 * a TTL there is drop + recreate.
 *
 * A collection that does not exist yet has no index to reconcile, and that is
 * the ordinary state of every NEW TTL collection on its first deploy. Reading
 * the indexes first made that state fatal: production 2026-08-20 08:23 crash-
 * looped on `ns does not exist: LyAdminBot.burst_windows` — the newest window
 * collection, which nothing had written to, in a restart loop that could never
 * reach the `createIndex` below that would have created it.
 *
 * Only THAT error is benign. Not-authorized, not-reachable or wrong-database
 * are configuration faults, and a bot that quietly ran on without its TTL
 * indexes would fill the cluster (it has hit its quota once already) instead of
 * saying so on the first line of its log.
 *
 * Module-level rather than a method: it touches no instance state, and as a
 * private method the behaviour above could not be tested at all.
 */
export const ensureTtlIndex = async (
  collection: Collection<Document>,
  keySpec: Document,
  expireAfterSeconds: number,
): Promise<void> => {
  const key = JSON.stringify(keySpec)
  let current: Awaited<ReturnType<Collection<Document>['indexes']>> = []
  try {
    current = await collection.indexes()
  } catch (err) {
    if ((err as { code?: number }).code !== NAMESPACE_NOT_FOUND) throw err
    // Nothing to reconcile — fall through to the create, which makes both the
    // collection and the index.
  }
  const existing = current.find((ix) => JSON.stringify(ix.key) === key)
  if (existing && existing.expireAfterSeconds !== expireAfterSeconds) {
    try {
      await collection.dropIndex(existing.name as string)
    } catch (err) {
      // If even dropIndex is denied (stricter M0 policies), keep the stale
      // TTL rather than crash startup — a bounded-but-wrong retention beats
      // an unbootable bot. Surface it so the mismatch shows up in logs.
      console.warn(
        `[mongo] cannot retune TTL index ${existing.name ?? key} on ${collection.collectionName} ` +
          `(${existing.expireAfterSeconds}s → ${expireAfterSeconds}s): ${(err as Error).message}`,
      )
      return
    }
  }
  await collection.createIndex(keySpec, { expireAfterSeconds })
}

export class MongoStore {
  private client: MongoClient | null = null
  private db: Db | null = null

  async connect(uri: string): Promise<void> {
    this.client = new MongoClient(uri)
    await this.client.connect()
    this.db = this.client.db() // db name comes from the URI, same as v1
    await this.ensureIndexes()
  }

  async close(): Promise<void> {
    await this.client?.close()
    this.client = null
    this.db = null
  }

  private collection(name: string): Collection<Document> {
    if (!this.db) throw new Error('MongoStore is not connected')
    return this.db.collection(name)
  }

  // v1 mongoose collections (names are mongoose-pluralized)
  get users(): Collection<Document> { return this.collection('users') }
  get groups(): Collection<Document> { return this.collection('groups') }
  get groupMembers(): Collection<Document> { return this.collection('groupmembers') }
  get spamSignatures(): Collection<Document> { return this.collection('spamsignatures') }
  get forwardBlacklist(): Collection<Document> { return this.collection('forwardblacklists') }
  // v1 ScheduledDeletion model → Mongoose collection 'scheduleddeletions'.
  get scheduledDeletions(): Collection<Document> { return this.collection('scheduleddeletions') }

  // v2 collections
  get decisions(): Collection<Document> { return this.collection('pipeline_decisions') }
  get feedback(): Collection<Document> { return this.collection('pipeline_feedback') }
  get llmCache(): Collection<Document> { return this.collection('llm_cache') }
  get votes(): Collection<Document> { return this.collection('pipeline_votes') }
  /** Resume cursor for the offline CAS signature harvester (tools/cas-harvest). */
  get harvestState(): Collection<Document> { return this.collection('cas_harvest_state') }
  // Persistent moderation state (survives restarts; TTL-expired).
  get velocityEvents(): Collection<Document> { return this.collection('velocity_events') }
  get sessionWindows(): Collection<Document> { return this.collection('session_windows') }
  /** A sender's recent judged messages per chat — see PersistentBurstPort. */
  get burstWindows(): Collection<Document> { return this.collection('burst_windows') }
  /**
   * What Telegram refuses us, per chat. Deliberately NOT TTL-expired: unlike
   * every other collection here it holds a fact rather than an observation, and
   * "the bot is not an admin in this chat" stops being true only when a person
   * makes it stop. One small document per chat that ever refused us, removed the
   * moment anything succeeds there.
   */
  get rightsBlocks(): Collection<Document> { return this.collection('pipeline_rights') }

  private async ensureIndexes(): Promise<void> {
    await ensureTtlIndex(this.decisions, { createdAt: 1 }, DECISIONS_TTL_DAYS * 86400)
    await this.decisions.createIndex({ chatId: 1, userId: 1, createdAt: -1 })
    // Why?/override lookup (getDecision) filters by chat+message.
    await this.decisions.createIndex({ chatId: 1, messageId: 1, createdAt: -1 })
    await this.feedback.createIndex({ chatId: 1, messageId: 1 })
    await ensureTtlIndex(this.llmCache, { createdAt: 1 }, LLM_CACHE_TTL_DAYS * 86400)
    await this.llmCache.createIndex({ key: 1 }, { unique: true })
    await this.votes.createIndex({ chatId: 1, messageId: 1 }, { unique: true })
    await ensureTtlIndex(this.votes, { createdAt: 1 }, 7 * 86400)
    // Drives the expiry sweep; without it the scan grows with the whole week.
    await this.votes.createIndex({ status: 1, expiresAt: 1 })
    // Scheduled deletions: single deleteAt index doubles as the due-query
    // index and a 1h TTL backstop (3600s after deleteAt) if a sweep is missed.
    await ensureTtlIndex(this.scheduledDeletions, { deleteAt: 1 }, 3600)
    // These TTLs ARE the windows — the aggregate is the surviving document, and
    // no query bounds it. Read from the port constants so the number cannot
    // drift from the thresholds that were calibrated against it; the ports used
    // to carry a `windowMs` of their own that this method silently overruled.
    await ensureTtlIndex(this.velocityEvents, { firstSeenAt: 1 }, VELOCITY_WINDOW_MS / 1000)
    await ensureTtlIndex(this.sessionWindows, { startedAt: 1 }, SESSION_WINDOW_MS / 1000)
    await ensureTtlIndex(this.burstWindows, { startedAt: 1 }, BURST_WINDOW_MS / 1000)
    // `spamsignatures` is a v1 collection and v1 owns the exactHash/normalizedHash
    // indexes. The folded layer added in 2026-07-31 needs its own, or the `$or`
    // in `MongoSignaturePort.match` loses index coverage for that branch and
    // scans the collection on every message. Sparse: documents written before
    // the field existed only gain it when they are next seen.
    await this.spamSignatures.createIndex({ foldedHash: 1 }, { sparse: true })
  }

  // ── reads used per message ───────────────────────────────────────────

  async getUserDoc(telegramId: number): Promise<Document | null> {
    return this.users.findOne({ telegram_id: telegramId })
  }

  async getGroupDoc(groupId: number): Promise<Document | null> {
    return this.groups.findOne({ group_id: groupId })
  }

  /** Messages this user wrote in this group (v1 groupmembers stats). */
  async getMemberMessageCount(groupObjectId: unknown, telegramId: number): Promise<number> {
    if (!groupObjectId) return 0
    const member = await this.groupMembers.findOne(
      { group: groupObjectId, telegram_id: telegramId },
      { projection: { 'stats.messagesCount': 1 } }
    )
    return (member as { stats?: { messagesCount?: number } } | null)?.stats?.messagesCount ?? 0
  }

  /**
   * Member stats for /stats and for the ballot bar, which want different
   * numbers out of the same document.
   *
   * `messagesCount` is traffic: how much this member wrote, the v1 meaning,
   * and what the stats view reports. `standingInChat` is what that traffic
   * earns — the same subtraction `touchMember` returns to the pipeline.
   *
   * They were one number until 2026-08-23, and the ballot bar read the traffic
   * one. Ten adverts posted into one chat and removed by the chat therefore
   * still bought their sender a vote a week later, because the messages were
   * counted and the removals were not. Detections do not cover that case, and
   * cannot: an account collects at most ONE of them per chat, so a sender
   * working a single room never reaches the two that would take the vote away.
   */
  async getMemberStats(chatId: number, telegramId: number): Promise<{
    messagesCount: number
    standingInChat: number
    bananCount: number
  }> {
    const empty = { messagesCount: 0, standingInChat: 0, bananCount: 0 }
    const group = await this.groups.findOne({ group_id: chatId }, { projection: { _id: 1 } })
    if (!group) return empty
    const member = await this.groupMembers.findOne(
      { group: group['_id'], telegram_id: telegramId },
      { projection: { 'stats.messagesCount': 1, 'stats.spamMessages': 1, 'banan.num': 1 } }
    ) as { stats?: { messagesCount?: number; spamMessages?: number }; banan?: { num?: number } } | null
    if (!member) return empty
    return {
      messagesCount: member.stats?.messagesCount ?? 0,
      standingInChat: standingFrom(member.stats),
      bananCount: member.banan?.num ?? 0
    }
  }

  /**
   * Group leaderboard rows for /top (by messages) and /top-banan (by banana
   * count). Reads the same groupmembers doc touchMember maintains; returns
   * telegram ids + values, name resolution is the caller's job.
   */
  async getTopMembers(
    chatId: number,
    by: 'messages' | 'banan',
    limit: number
  ): Promise<{ telegramId: number; value: number }[]> {
    const group = await this.groups.findOne({ group_id: chatId }, { projection: { _id: 1 } })
    if (!group) return []
    const field = by === 'banan' ? 'banan.num' : 'stats.messagesCount'
    const rows = await this.groupMembers
      .find({ group: group['_id'], [field]: { $gt: 0 } }, { projection: { telegram_id: 1, [field]: 1 } })
      .sort({ [field]: -1 })
      .limit(limit)
      .toArray()
    return rows.map((r) => ({
      telegramId: Number(r['telegram_id']),
      value: by === 'banan'
        ? Number((r as { banan?: { num?: number } }).banan?.num ?? 0)
        : Number((r as { stats?: { messagesCount?: number } }).stats?.messagesCount ?? 0)
    }))
  }

  // ── custom hashtag triggers (extras) ────────────────────────────────

  /** All extras for a chat, normalized from either storage shape. */
  async getExtras(chatId: number): Promise<NormalizedExtra[]> {
    const group = await this.groups.findOne(
      { group_id: chatId },
      { projection: { 'settings.extras': 1 } }
    ) as { settings?: { extras?: unknown[] } } | null
    const raw = group?.settings?.extras ?? []
    return raw.map(normalizeExtra).filter((e): e is NormalizedExtra => e !== null)
  }

  /** Per-message extra cap (v1 settings.maxExtra, default 3 as in v1). */
  async getMaxExtra(chatId: number): Promise<number> {
    const group = await this.groups.findOne(
      { group_id: chatId },
      { projection: { 'settings.maxExtra': 1 } }
    ) as { settings?: { maxExtra?: number } } | null
    const n = Number(group?.settings?.maxExtra)
    return Number.isFinite(n) && n > 0 ? n : 3
  }

  /** Clamp and persist the per-message extra cap (1..10). */
  async setMaxExtra(chatId: number, n: number): Promise<void> {
    const clamped = Math.max(1, Math.min(10, Math.round(n)))
    await this.groups.updateOne(
      { group_id: chatId },
      { $set: { 'settings.maxExtra': clamped }, $setOnInsert: { group_id: chatId } },
      { upsert: true }
    )
  }

  /** Upsert an extra by name (case-insensitive replace), v2 shape. */
  async saveExtra(chatId: number, extra: NormalizedExtra): Promise<void> {
    const existing = await this.getExtras(chatId)
    const kept = existing.filter((e) => e.name.toLowerCase() !== extra.name.toLowerCase())
    kept.push(extra)
    await this.groups.updateOne(
      { group_id: chatId },
      { $set: { 'settings.extras': kept }, $setOnInsert: { group_id: chatId } },
      { upsert: true }
    )
  }

  /** Remove an extra by name. Returns true if one was removed. */
  async deleteExtra(chatId: number, name: string): Promise<boolean> {
    const existing = await this.getExtras(chatId)
    const kept = existing.filter((e) => e.name.toLowerCase() !== name.toLowerCase())
    if (kept.length === existing.length) return false
    await this.groups.updateOne({ group_id: chatId }, { $set: { 'settings.extras': kept } })
    return true
  }

  // ── welcome messages (off by default) ───────────────────────────────

  /** Welcome config for a chat (v1 settings.welcome shape). */
  async getWelcome(chatId: number): Promise<{ enable: boolean; texts: string[]; gifs: string[]; timer: number }> {
    const group = await this.groups.findOne(
      { group_id: chatId },
      { projection: { 'settings.welcome': 1 } }
    ) as { settings?: { welcome?: { enable?: boolean; texts?: unknown[]; gifs?: unknown[]; timer?: number } } } | null
    const w = group?.settings?.welcome
    return {
      enable: w?.enable === true,
      texts: (w?.texts ?? []).filter((t): t is string => typeof t === 'string' && t.length > 0),
      gifs: (w?.gifs ?? []).filter((g): g is string => typeof g === 'string' && g.length > 0),
      timer: Number.isFinite(Number(w?.timer)) && Number(w?.timer) > 0 ? Number(w?.timer) : 60
    }
  }

  async setWelcomeEnabled(chatId: number, enable: boolean): Promise<void> {
    await this.groups.updateOne(
      { group_id: chatId },
      { $set: { 'settings.welcome.enable': enable }, $setOnInsert: { group_id: chatId } },
      { upsert: true }
    )
  }

  /**
   * Append a welcome text (with %name%), dedup + capped, and enable greetings.
   * Returns whether it was added and, if not, the machine-readable reason.
   */
  async addWelcomeText(chatId: number, text: string): Promise<{ added: boolean; reason?: AddReason }> {
    const { texts } = await this.getWelcome(chatId)
    const result = addWelcomeItem(texts, text, { max: MAX_WELCOME_TEXTS, maxLen: MAX_WELCOME_TEXT_LEN })
    if (!result.added) return result.reason !== undefined ? { added: false, reason: result.reason } : { added: false }
    await this.groups.updateOne(
      { group_id: chatId },
      { $set: { 'settings.welcome.texts': result.list, 'settings.welcome.enable': true }, $setOnInsert: { group_id: chatId } },
      { upsert: true }
    )
    return { added: true }
  }

  /** Remove the welcome text at `index`. Returns true if one was removed. */
  async removeWelcomeText(chatId: number, index: number): Promise<boolean> {
    const { texts } = await this.getWelcome(chatId)
    const next = removeAt(texts, index)
    if (next.length === texts.length) return false
    await this.groups.updateOne({ group_id: chatId }, { $set: { 'settings.welcome.texts': next } })
    return true
  }

  /**
   * Append a welcome gif/animation (file id), dedup + capped, and enable
   * greetings. Returns whether it was added and, if not, the reason.
   */
  async addWelcomeGif(chatId: number, fileId: string): Promise<{ added: boolean; reason?: AddReason }> {
    const { gifs } = await this.getWelcome(chatId)
    const result = addWelcomeItem(gifs, fileId, { max: MAX_WELCOME_GIFS })
    if (!result.added) return result.reason !== undefined ? { added: false, reason: result.reason } : { added: false }
    await this.groups.updateOne(
      { group_id: chatId },
      { $set: { 'settings.welcome.gifs': result.list, 'settings.welcome.enable': true }, $setOnInsert: { group_id: chatId } },
      { upsert: true }
    )
    return { added: true }
  }

  /** Remove the welcome gif at `index`. Returns true if one was removed. */
  async removeWelcomeGif(chatId: number, index: number): Promise<boolean> {
    const { gifs } = await this.getWelcome(chatId)
    const next = removeAt(gifs, index)
    if (next.length === gifs.length) return false
    await this.groups.updateOne({ group_id: chatId }, { $set: { 'settings.welcome.gifs': next } })
    return true
  }

  /** v2-additive per-user UI locale (users.v2Locale). */
  async getUserLocale(telegramId: number): Promise<string | null> {
    const doc = await this.users.findOne(
      { telegram_id: telegramId },
      { projection: { v2Locale: 1 } }
    )
    return (doc as { v2Locale?: string } | null)?.v2Locale ?? null
  }

  async setUserLocale(telegramId: number, locale: string): Promise<void> {
    await this.users.updateOne(
      { telegram_id: telegramId },
      { $set: { v2Locale: locale }, $setOnInsert: { telegram_id: telegramId } },
      { upsert: true }
    )
  }

  // ── writes ───────────────────────────────────────────────────────────

  /**
   * Persist external ban-database lookups under user.externalBan.{lols,cas}.
   * Each side is written only when present, so a single failed source never
   * overwrites a previously-cached good answer with a hole.
   */
  async saveExternalBan(
    telegramId: number,
    lookup: {
      lols: object | null
      cas: object | null
      attempted?: { lols: boolean; cas: boolean }
    },
    now: Date = new Date()
  ): Promise<void> {
    const set: Record<string, unknown> = {}
    const unset: Record<string, unknown> = {}
    for (const source of ['lols', 'cas'] as const) {
      if (lookup[source]) {
        set[`externalBan.${source}`] = lookup[source]
        unset[`externalBan.failedAt.${source}`] = ''
      } else if (lookup.attempted?.[source]) {
        // Asked, and got nothing back. Recording the attempt is the whole reason
        // the next message does not ask again: `EXTERNAL_BAN_RETRY_MS`. Silence
        // used to leave no trace, so the retry had no floor.
        set[`externalBan.failedAt.${source}`] = now
      }
    }
    const update: Record<string, unknown> = {}
    if (Object.keys(set).length > 0) update['$set'] = set
    if (Object.keys(unset).length > 0) update['$unset'] = unset
    if (Object.keys(update).length === 0) return
    await this.users.updateOne({ telegram_id: telegramId }, update, { upsert: true })
  }

  /**
   * Every chat that has refused us something, for adoption at startup.
   *
   * One query at boot rather than a lookup per chat, because the caller answers
   * "may I enforce here" synchronously on the hot path. The set is bounded by
   * the number of chats where the bot is not an admin — dozens, not thousands.
   */
  async loadRightsBlocks(): Promise<RightsBlockRecord[]> {
    // A record also exists purely to hold a nag quota, for chats that refused a
    // manual command without an execution ever reaching the pipeline. Once that
    // quota lapses such a record says nothing at all, and on a size-capped
    // cluster "says nothing" must not accumulate one document per group. Cleared
    // here rather than on a timer: boot is the one moment we read them all
    // anyway, so it costs a single extra query.
    const spent = {
      deleteRefused: { $ne: true },
      senderRefused: { $ne: true },
      warnedUntil: { $lt: Date.now() }
    }
    await this.rightsBlocks.deleteMany(spent).catch(() => { /* tidiness is not correctness */ })
    const docs = await this.rightsBlocks.find({}).toArray()
    return docs.map((d) => ({
      chatId: Number(d['chatId']),
      deleteRefused: d['deleteRefused'] === true,
      senderRefused: d['senderRefused'] === true,
      strikes: Number(d['strikes'] ?? 0),
      probeAt: Number(d['probeAt'] ?? 0),
      warnedUntil: Number(d['warnedUntil'] ?? 0)
    })).filter((r) => Number.isFinite(r.chatId))
  }

  /** Write one chat's refusal record, or remove it when the chat came good. */
  async saveRightsBlock(chatId: number, record: RightsBlockRecord | null): Promise<void> {
    if (record === null) {
      await this.rightsBlocks.deleteOne({ chatId })
      return
    }
    await this.rightsBlocks.updateOne(
      { chatId },
      { $set: { ...record, chatId, updatedAt: new Date() } },
      { upsert: true }
    )
  }

  /**
   * False-positive counts grouped by what decided them — the input to the
   * calibration runbook (docs/calibration.md). Each pipeline_feedback
   * `override_not_spam` is an admin-confirmed FP; grouping by decidedBy/ruleId
   * shows which signals/rules to demote in score.ts.
   */
  async falsePositivesByRule(sinceMs: number): Promise<{ decidedBy: string; ruleId: string | null; count: number }[]> {
    const rows = await this.feedback.aggregate([
      { $match: { kind: 'override_not_spam', createdAt: { $gte: new Date(sinceMs) } } },
      { $group: { _id: { decidedBy: '$decidedBy', ruleId: '$ruleId' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray()
    return rows.map((r) => ({
      decidedBy: String((r['_id'] as { decidedBy?: string }).decidedBy ?? 'unknown'),
      ruleId: ((r['_id'] as { ruleId?: string | null }).ruleId ?? null),
      count: Number(r['count'] ?? 0)
    }))
  }

  /**
   * Recent confirmed-spam sample texts — the raw material for the LLM
   * "active campaigns this week" briefing (dynamic few-shot self-learning).
   */
  async recentConfirmedSpamSamples(limit: number, sinceMs: number): Promise<string[]> {
    const docs = await this.spamSignatures
      .find(
        { status: 'confirmed', lastSeenAt: { $gte: new Date(sinceMs) } },
        { projection: { sampleText: 1 }, sort: { lastSeenAt: -1 }, limit }
      )
      .toArray()
    return docs
      .map((d) => String((d as { sampleText?: string }).sampleText ?? ''))
      .filter((t) => t.trim().length > 0)
  }

  // ── VelocityBackend / SessionBackend (persistent-ports.ts) ───────────

  /** One velocity sighting of `hash`; the doc TTL-expires to define the window. */
  async bumpVelocity(hash: string, chatId: number, userId: number): Promise<{ count: number; chatCount: number; userCount: number }> {
    const doc = await this.velocityEvents.findOneAndUpdate(
      { _id: hash } as never,
      {
        $inc: { count: 1 },
        $addToSet: { chats: chatId, users: userId },
        $setOnInsert: { firstSeenAt: new Date() }
      } as never,
      { upsert: true, returnDocument: 'after' }
    ) as { count?: number; chats?: number[]; users?: number[] } | null
    return {
      count: doc?.count ?? 1,
      chatCount: doc?.chats?.length ?? 1,
      userCount: doc?.users?.length ?? 1
    }
  }

  /** Append to a session window (TTL-expired), trimmed to the last maxMessages. */
  async appendSession(key: string, text: string, maxMessages: number): Promise<string[]> {
    const doc = await this.sessionWindows.findOneAndUpdate(
      { _id: key } as never,
      {
        $push: { texts: { $each: text ? [text] : [], $slice: -maxMessages } },
        $setOnInsert: { startedAt: new Date() }
      } as never,
      { upsert: true, returnDocument: 'after' }
    ) as { texts?: string[] } | null
    return doc?.texts ?? []
  }

  async resetSession(key: string): Promise<void> {
    await this.sessionWindows.deleteOne({ _id: key } as never)
  }

  async appendBurst(key: string, entry: BurstEntry, maxEntries: number): Promise<void> {
    await this.burstWindows.updateOne(
      { _id: key } as never,
      {
        $push: { entries: { $each: [entry], $slice: -maxEntries } },
        // The TTL runs from the run's FIRST message, so this must not be
        // refreshed on every append — see BURST_WINDOW_MS.
        $setOnInsert: { startedAt: new Date() }
      } as never,
      { upsert: true }
    )
  }

  async readBurst(key: string): Promise<BurstEntry[]> {
    const doc = await this.burstWindows.findOne({ _id: key } as never) as
      { entries?: BurstEntry[] } | null
    return doc?.entries ?? []
  }

  async resetBurst(key: string): Promise<void> {
    await this.burstWindows.deleteOne({ _id: key } as never)
  }

  /** Track first-seen + global message counters (additive to v1 fields). */
  async touchUser(telegramId: number): Promise<void> {
    await this.users.updateOne(
      { telegram_id: telegramId },
      {
        $setOnInsert: { telegram_id: telegramId, 'globalStats.firstSeen': new Date() },
        $inc: { 'globalStats.totalMessages': 1 }
      },
      { upsert: true }
    )
  }

  /**
   * Per-chat member counters (v1 groupmembers shape). v1 stopped writing
   * these the moment it was switched off, so v2 must maintain them or
   * every user would look like a newcomer forever.
   *
   * Returns the STANDING before this message — the count of prior messages
   * minus the ones the pipeline judged to be spam. That is what "new in chat"
   * must see, and the subtraction is the whole point (2026-07-31): this method
   * necessarily runs before the verdict, because the count is an input to it, so
   * a message's credit is paid before we know what the message was. Production
   * showed the consequence — one advert reposted nine times into one chat, its
   * newness signals dropping out one by one as the counter grew, the score
   * sinking 0.91 → 0.75 while the evidence against it accumulated. Ten such
   * messages also clear `EXEMPT_INCHAT_MIN` and buy a bypass of the pipeline.
   *
   * `stats.messagesCount` itself keeps counting every message. It is a v1 field
   * and it answers a different, honest question — how much traffic this member
   * produced — which the /stats view reports. Standing is a reading of it, not
   * a redefinition.
   */
  async touchMember(chatId: number, telegramId: number, textLength: number): Promise<number> {
    const group = await this.groups.findOneAndUpdate(
      { group_id: chatId },
      { $setOnInsert: { group_id: chatId } },
      { upsert: true, returnDocument: 'after', projection: { _id: 1 } }
    )
    if (!group) return 0
    const now = new Date()
    const before = await this.groupMembers.findOneAndUpdate(
      { group: group['_id'], telegram_id: telegramId },
      {
        $setOnInsert: {
          group: group['_id'],
          telegram_id: telegramId,
          'stats.joinedAt': now,
          'stats.firstMessageAt': now
        },
        $inc: { 'stats.messagesCount': 1, 'stats.textTotal': Math.max(0, textLength) },
        // v1 (mongoose) maintained this and v2 did not, which made the field
        // mean "last seen" for old rows and nothing at all for new ones. The
        // dormancy sweep asks `updatedAt < cutoff` and Mongo does not match a
        // missing field against `$lt`, so every row this method created was
        // permanently unprunable: the backlog would clear once and then the
        // collection would grow for ever, unswept, which is how it reached
        // 483k rows against a 512 MB cluster in the first place.
        $set: { updatedAt: now }
      },
      {
        upsert: true,
        returnDocument: 'before',
        projection: { 'stats.messagesCount': 1, 'stats.spamMessages': 1 }
      }
    )
    const stats = (before as { stats?: { messagesCount?: number; spamMessages?: number } } | null)?.stats
    return standingFrom(stats)
  }

  /**
   * Move one message in or out of the bucket that does not count toward
   * standing: `delta` is +1 when the pipeline judged a message to be spam, −1
   * when an admin took that judgement back.
   *
   * Both scopes are debited. The per-chat counter catches a sender who works one
   * group; the global one catches a cross-chat blaster, who posts once per chat
   * and would otherwise never register locally while their global standing —
   * which alone can reach `ESTABLISHED_MIN_MESSAGES` and earn the
   * `established_user` trust weight — grows with every hit.
   *
   * The decrement matters as much as the increment. A false positive would
   * otherwise cost its victim standing permanently, and standing is exactly what
   * makes the NEXT false positive against them less likely. It is guarded in the
   * filter rather than by reading first, because two writers touch these fields.
   *
   * No upsert, deliberately: both documents were just written by `touchUser` and
   * `touchMember` for this very message. A missing one means the counters were
   * never established, and inventing a document holding nothing but a spam count
   * would state that the sender's every message was spam.
   *
   * `detection` moves a second, stricter counter alongside the first.
   * `globalStats.spamDetections` is what tells the pipeline that an account has
   * a history rather than a bad message — and until 2026-08-01 nothing in v2
   * wrote it, so four mechanisms read a field that could only ever hold what v1
   * had left behind. The visible symptom was an account caught six times in a
   * hundred minutes being shielded from a ban every single time, because the
   * shield is lifted by exactly this counter.
   *
   * It is global only. A detection is a statement about the account, and the
   * per-chat document already carries the per-chat story.
   */
  /**
   * Record a detection against the account WITHOUT debiting standing again.
   *
   * The two travel together on the automatic path, where one message produces
   * one verdict. A vote is the other shape: the uncertain enforcement already
   * debited the message on its way out (`adjustSpamMessages(+1, false)`), and
   * the chat's later answer adds the finding about the account, not a second
   * message. Charging both would cost one message two messages' worth of
   * standing, locally and globally.
   *
   * Counted once per chat — see the filter.
   */
  async recordSpamDetection(chatId: number, telegramId: number): Promise<void> {
    // One chat, one detection, however many of its questions resolve against
    // this account. Two detections strip the vote, the established-regular
    // exempt and the ban shield at once, so a single room — which may be the
    // very crew being judged — must not be able to produce them both. The
    // filter and the `$addToSet` are one operation, so two resolutions racing
    // in the same chat cannot both slip through.
    await this.users.updateOne(
      { telegram_id: telegramId, 'globalStats.detectionChats': { $ne: chatId } },
      {
        $inc: { 'globalStats.spamDetections': 1 },
        $addToSet: { 'globalStats.detectionChats': chatId }
      }
    )
  }

  async adjustSpamMessages(
    chatId: number, telegramId: number, delta: 1 | -1, detection = false
  ): Promise<void> {
    const floor = delta < 0 ? { $gt: 0 } : null
    const group = await this.groups.findOne({ group_id: chatId }, { projection: { _id: 1 } })
    await Promise.all([
      this.users.updateOne(
        { telegram_id: telegramId, ...(floor ? { 'globalStats.spamMessages': floor } : {}) },
        { $inc: { 'globalStats.spamMessages': delta } }
      ),
      // Its own update, not another `$inc` on the one above: the decrement's
      // floor lives in the filter, so sharing a filter would let an
      // already-zero counter veto the other one's decrement.
      detection
        ? this.users.updateOne(
          { telegram_id: telegramId, ...(floor ? { 'globalStats.spamDetections': floor } : {}) },
          { $inc: { 'globalStats.spamDetections': delta } }
        )
        : Promise.resolve(),
      group
        ? this.groupMembers.updateOne(
          { group: group['_id'], telegram_id: telegramId, ...(floor ? { 'stats.spamMessages': floor } : {}) },
          { $inc: { 'stats.spamMessages': delta } }
        )
        : Promise.resolve()
    ])
  }

  /**
   * Drop records of people who left no trace and have not been seen since.
   *
   * The two v1 collections grow by one document per account per chat, for ever,
   * and nothing has ever removed one. On 2026-08-24 that was 483k members and
   * 126k users against a 512 MB free-tier cluster sitting at 457 MB — and Atlas
   * measures the quota as `dataSize + indexSize`, both of which this reduces
   * (the data at once; the indexes when they are next rebuilt). It has run out
   * of room once already, on 2026-07-06, and a full cluster does not degrade
   * gracefully: it stops accepting writes, which stops the bot recording
   * anything it decides.
   *
   * WHAT IS SAFE TO DROP is the whole design, because the last cleanup is also
   * the thing this pipeline's oldest scar is named after. Standing lives in
   * these documents, and deleting a regular's row makes them a stranger to
   * every newness signal at once. So the bar is: at most one message, nothing
   * punitive recorded, and untouched for {@link DORMANT_DAYS}. One message is
   * below every threshold that reads these counters — `new_in_chat` fires at 3
   * or fewer, standing needs 10 — so removing the row changes no signal for
   * anybody, which is the property that makes this reversible in effect if not
   * in fact.
   *
   * Tenure survives it too. `mergeTenureDays` takes the LARGER of our first-seen
   * date and Telegram's own join date for the chat, and the second is fetched
   * per message and owes nothing to this database.
   *
   * Bounded per call, and returning what it did, so the caller can run it on a
   * timer without a long-running delete on a shared-tier cluster.
   */
  /**
   * What the cluster is holding, in the two numbers a free tier is measured by.
   *
   * Atlas counts an M0's 512 MB as `dataSize + indexSize`, which is why the two
   * are returned apart: deleting documents moves the first immediately and the
   * second not at all until an index is rebuilt. Knowing which half is full is
   * the difference between pruning and reindexing.
   */
  async storageStats(): Promise<{ dataSize: number; indexSize: number }> {
    if (!this.db) throw new Error('MongoStore is not connected')
    const stats = await this.db.command({ dbStats: 1 })
    return { dataSize: Number(stats['dataSize'] ?? 0), indexSize: Number(stats['indexSize'] ?? 0) }
  }

  async pruneDormantRecords(limit = PRUNE_BATCH): Promise<{ members: number; users: number }> {
    const filters = dormantFilters()
    const ids = async (collection: Collection<Document>, filter: Document): Promise<ObjectId[]> =>
      (await collection.find(filter, { projection: { _id: 1 }, limit }).toArray()).map((d) => d._id)

    // Ids bound the batch; the predicate decides. Deleting on `_id` ALONE was
    // the inverse of the protection its comment claimed: a person who posts
    // between the select and the delete has their row updated and then removed
    // anyway, counter unread — which is the one case worth protecting against,
    // since it is the only one where the record had stopped being dormant.
    // Re-asserting the filter makes the delete a no-op for exactly those rows.
    const memberIds = await ids(this.groupMembers, filters.members)
    const userIds = await ids(this.users, filters.users)

    const members = memberIds.length > 0
      ? (await this.groupMembers.deleteMany({ ...filters.members, _id: { $in: memberIds } })).deletedCount
      : 0
    const users = userIds.length > 0
      ? (await this.users.deleteMany({ ...filters.users, _id: { $in: userIds } })).deletedCount
      : 0
    return { members, users }
  }

  async recordDecision(params: {
    chatId: number
    userId: number
    messageId: number
    textPreview: string
    verdict: Verdict
    /**
     * What this version of the message carried, so a later edit of it can be
     * measured even across a restart — see `getEditBaseline`.
     */
    editBaseline?: EditBaseline
    /**
     * What the executor managed to do about it. Optional so a replay, which
     * executes nothing, records a verdict without claiming an outcome — an
     * absent field and a failed action must stay distinguishable.
     */
    execution?: ExecutionRecord
    latencyMs: number
  }): Promise<void> {
    await this.decisions.insertOne({
      chatId: params.chatId,
      userId: params.userId,
      messageId: params.messageId,
      // `truncate`: BSON is UTF-8, so a slice through a surrogate pair does not
      // fail here — Node's encoder quietly substitutes U+FFFD and the record is
      // stored subtly wrong forever. Same defect that shouted on the LLM path
      // 2026-08-07; on this path it never says a word.
      textPreview: truncate(params.textPreview, 200),
      pSpam: params.verdict.pSpam,
      action: params.verdict.action,
      decidedBy: params.verdict.decidedBy,
      ruleId: params.verdict.ruleId,
      reasonCode: params.verdict.reasonCode,
      signals: params.verdict.signals.map((s) => s.name),
      needsVote: params.verdict.needsVote,
      banDurationSeconds: params.verdict.banDurationSeconds,
      meta: params.verdict.meta,
      ...(params.editBaseline === undefined ? {} : { editBaseline: params.editBaseline }),
      ...(params.execution === undefined ? {} : { execution: params.execution }),
      latencyMs: params.latencyMs,
      createdAt: new Date()
    })
  }

  /**
   * What the most recent judged version of this message carried.
   *
   * The in-process cache in the app layer answers this for anything recent; this
   * is what remains after a restart, and what makes an edit-injection verdict
   * reproducible offline. Sorted newest-first for the same reason
   * `getDecision` is: an edited message has one record per version, and a delta
   * is honest only against the version immediately before it.
   *
   * Reads the index `{ chatId, messageId, createdAt }` that already exists.
   */
  async getEditBaseline(chatId: number, messageId: number): Promise<EditBaseline | null> {
    const doc = await this.decisions.findOne(
      { chatId, messageId, editBaseline: { $exists: true } },
      { sort: { createdAt: -1 }, projection: { editBaseline: 1 } }
    )
    const baseline = doc?.['editBaseline'] as Partial<EditBaseline> | undefined
    if (!baseline) return null
    const { urls, mentions, invisibles } = baseline
    // A record written by an older build, or a partial one, is not a baseline:
    // reading a missing count as zero would report the whole message as freshly
    // injected — which on the invisibles half is a 0.93 mute for an ordinary edit.
    if (typeof urls !== 'number' || typeof mentions !== 'number' || typeof invisibles !== 'number') {
      return null
    }
    return { urls, mentions, invisibles }
  }

  /**
   * Add a message to the decision record of the run it belongs to.
   *
   * One record per incident rather than one per message (user decision
   * 2026-08-20). The alternative was a full row for every message of a flood,
   * and the cluster has hit its size quota once already — while for reading the
   * data back, eight rows that each say "this account was banned" are eight
   * copies of one event, and the audit has to re-derive the grouping every time.
   *
   * Strictly for messages with NO record of their own: the ones removed unread
   * because the sender was already gone. A message the pipeline actually judged
   * gets its own row, with its own signals and score, and must not also be
   * counted here — otherwise every count over the collection is inflated by
   * exactly the messages that are easiest to double-count.
   *
   * `incidentMessageIds` is capped: a run of hundreds is one event whose exact
   * tail nobody will ever look up, and an unbounded array in a document is how a
   * collection stops fitting in memory.
   */
  async appendIncidentMessage(
    chatId: number, triggerMessageId: number, messageIds: readonly number[]
  ): Promise<void> {
    // A list rather than one id: an album is several messages removed by one
    // decision, and a count that says 1 where 10 went makes every audit over
    // this collection understate what the incident cost.
    if (messageIds.length === 0) return
    await this.decisions.updateOne(
      { chatId, messageId: triggerMessageId },
      {
        $inc: { incidentCount: messageIds.length },
        $push: { incidentMessageIds: { $each: [...messageIds], $slice: -MongoStore.MAX_INCIDENT_IDS } }
      } as never
    )
  }

  /**
   * Rebuild a best-effort Verdict from the persisted decision, so the Why?
   * card and admin override survive a restart (the in-process verdict cache
   * is lost, but pipeline_decisions keeps the record for 90d). Signal
   * evidence is not persisted, so only signal names come back.
   */
  async getDecision(chatId: number, messageId: number): Promise<Verdict | null> {
    const doc = await this.decisions.findOne({ chatId, messageId }, { sort: { createdAt: -1 } })
    if (!doc) return null
    const signalNames = Array.isArray(doc['signals']) ? (doc['signals'] as unknown[]) : []
    return {
      pSpam: Number(doc['pSpam'] ?? 0),
      action: (doc['action'] ?? 'none') as Verdict['action'],
      needsVote: Boolean(doc['needsVote']),
      // Rebuilt only for display/override; the ban itself was already applied
      // when the decision was made, so a missing value is simply "unknown".
      banDurationSeconds: typeof doc['banDurationSeconds'] === 'number'
        ? (doc['banDurationSeconds'] as number)
        : null,
      decidedBy: (doc['decidedBy'] ?? 'error') as Verdict['decidedBy'],
      ruleId: (doc['ruleId'] as string | null) ?? null,
      // A stored decision keeps signal NAMES only, and it may name a signal the
      // catalogue has since renamed or dropped — so this is the one place a
      // `SignalName` is asserted rather than known. Everything downstream is
      // built to survive that: `weightOf` scores an unknown name as 0,
      // `isTrustSignal` calls it accusing, and `renderWhy` shows the raw name.
      // This value is display-and-override only; it is never re-scored.
      signals: signalNames.map((n) => ({ name: String(n) as Signal['name'] })),
      reasonCode: String(doc['reasonCode'] ?? 'unknown'),
      reasonEvidence: (doc['textPreview'] as string | null) ?? null,
      meta: (doc['meta'] as Record<string, string | number | boolean>) ?? {}
    }
  }

  /**
   * Admin override implies chat-level trust: the admin has vouched for
   * this user, so the same person must never be auto-actioned here again.
   * (Trusted is a policy CAP, not a blind pass — promo content still goes
   * through the pipeline and can reach delete+vote.)
   * Writes into the v1-compatible settings.openaiSpamCheck.trustedUsers.
   */
  async addTrustedUser(chatId: number, userId: number): Promise<void> {
    await this.groups.updateOne(
      { group_id: chatId },
      { $addToSet: { 'settings.openaiSpamCheck.trustedUsers': userId } }
    )
  }

  /** Reverse of addTrustedUser — revoke an auto-trust an admin granted by mistake.
   * Returns whether the user was actually in the trusted list. */
  async removeTrustedUser(chatId: number, userId: number): Promise<boolean> {
    const res = await this.groups.updateOne(
      { group_id: chatId },
      { $pull: { 'settings.openaiSpamCheck.trustedUsers': userId } } as never
    )
    return res.modifiedCount > 0
  }

  // ── community votes (survive restarts; TTL 7d like modevents) ─────────

  /**
   * Ceiling for the text a resolved vote will teach — Telegram's own maximum
   * for a message, so it can never shorten one that really arrived.
   *
   * This is not a display budget. `learnText` is hashed verbatim when the vote
   * resolves, so a cap that trims a real message files the lesson under a hash
   * no copy of that message will ever produce. It sat at 1000 until 2026-08-02,
   * when a long text in one chat was voted spam six times while every further
   * copy still raised nothing but the candidate the auto-learner had written —
   * the auto-learner keeps the text whole, so the two writers of one store were
   * hashing different strings and neither could ever promote the other's entry.
   */
  private static readonly MAX_LEARN_TEXT = 4096
  /** Message ids kept on one incident's decision record — see appendIncidentMessage. */
  private static readonly MAX_INCIDENT_IDS = 50

  /** Open a vote. Returns false when one already exists for this message. */
  async openVote(params: {
    chatId: number
    messageId: number
    targetUserId: number
    targetLabel: string
    textPreview: string
    /** Full message text for signature learning on resolution (preview is display-only). */
    learnText?: string
    openedBy: number
  }): Promise<boolean> {
    const now = Date.now()
    try {
      await this.votes.insertOne({
        chatId: params.chatId,
        messageId: params.messageId,
        targetUserId: params.targetUserId,
        targetLabel: truncate(params.targetLabel, 64),
        textPreview: truncate(params.textPreview, 200),
        // `learnText` matters most of the three: it is hashed later to match the
        // signature it teaches, and a U+FFFD substituted at the cut is a byte
        // difference the hash sees.
        learnText: truncate(params.learnText ?? params.textPreview, MongoStore.MAX_LEARN_TEXT),
        openedBy: params.openedBy,
        promptMessageId: null,
        ballots: [],
        status: 'open',
        createdAt: new Date(now),
        // The moment the question stops being askable — see VOTE_WINDOW_SECONDS.
        expiresAt: new Date(now + VOTE_WINDOW_SECONDS * 1000)
      })
      return true
    } catch {
      return false // duplicate key — vote already open
    }
  }

  async setVotePrompt(chatId: number, messageId: number, promptMessageId: number): Promise<void> {
    await this.votes.updateOne({ chatId, messageId }, { $set: { promptMessageId } })
  }

  async getVote(chatId: number, messageId: number): Promise<Document | null> {
    return this.votes.findOne({ chatId, messageId })
  }

  /** Append a ballot (idempotent per user: previous ballots stay, tally takes the latest). */
  async castBallot(params: {
    chatId: number
    messageId: number
    userId: number
    isAdmin: boolean
    choice: 'spam' | 'ham'
    /**
     * Display name at the moment of the tap, for the roster the resolved vote
     * shows. Omitted rather than blanked when unknown, so a roster can tell
     * "no name was recorded" from "their name is empty".
     */
    label?: string
  }): Promise<boolean> {
    const ballot = {
      userId: params.userId, isAdmin: params.isAdmin, choice: params.choice, at: new Date(),
      ...(params.label !== undefined && params.label !== '' ? { label: truncate(params.label, 64) } : {})
    }
    const result = await this.votes.updateOne(
      // `expiresAt` as well as `status`: the sweep that flips the status runs
      // once a minute, so the status alone leaves a window — a whole restart
      // gap, at worst — in which a question whose time is up still takes
      // answers. The write itself is the only place that can be exact.
      {
        chatId: params.chatId, messageId: params.messageId, status: 'open',
        expiresAt: { $gt: new Date() }
      },
      // The driver's PushOperator<Document> rejects concrete array elements.
      { $push: { ballots: ballot } } as never
    )
    // Reported, not swallowed: the filter can miss because the question closed
    // OR because its window ran out before the sweep noticed, and a caller that
    // cannot tell the difference between those and success answers "counted"
    // for a ballot it never wrote.
    return result.modifiedCount === 1
  }

  // ── scheduled deletions (persistent, survives restarts) ──────────────

  /**
   * Persist a message for later deletion. The bot also sets an in-memory
   * timer for the fast path; this row is the crash-recovery backstop.
   */
  async scheduleDeletion(params: {
    chatId: number
    messageId: number
    delayMs: number
    source?: string
  }): Promise<void> {
    await this.scheduledDeletions.insertOne({
      chatId: params.chatId,
      messageId: params.messageId,
      deleteAt: new Date(Date.now() + params.delayMs),
      source: params.source ?? 'other',
      createdAt: new Date()
    })
  }

  /** Drop a pending row (after the in-memory timer already deleted it). */
  async unscheduleDeletion(chatId: number, messageId: number): Promise<void> {
    await this.scheduledDeletions.deleteOne({ chatId, messageId })
  }

  /**
   * Claim all due deletions: returns the targets and removes their rows in
   * one pass, so the periodic sweep never double-processes. Single bot
   * instance + idempotent Telegram delete makes the find→delete race safe.
   */
  async claimDueDeletions(limit = 200): Promise<{ chatId: number; messageId: number }[]> {
    const due = await this.scheduledDeletions
      .find({ deleteAt: { $lte: new Date() } })
      .limit(limit)
      .toArray()
    if (due.length === 0) return []
    await this.scheduledDeletions.deleteMany({ _id: { $in: due.map((d) => d['_id']) } })
    return due.map((d) => ({ chatId: Number(d['chatId']), messageId: Number(d['messageId']) }))
  }

  /**
   * Take every vote whose window has passed, marking each expired.
   *
   * Claimed one at a time through the same `status: 'open'` guard `closeVote`
   * uses: the sweep runs on a timer and a restart can overlap the previous run,
   * so two callers must never both act on one question. Only the rows this call
   * actually flipped come back.
   */
  async claimExpiredVotes(limit = 50): Promise<{
    chatId: number; messageId: number; targetUserId: number; promptMessageId: number | null
  }[]> {
    const due = await this.votes
      // The `$or` carries rows written before votes had a window: they match
      // neither `expiresAt > now` (so they refuse every ballot) nor a plain
      // `expiresAt <= now`, which left them apparently open forever with their
      // prompt still in the chat. A row with no deadline is past it.
      .find({
        status: 'open',
        $or: [{ expiresAt: { $lte: new Date() } }, { expiresAt: { $exists: false } }]
      })
      .limit(limit)
      .toArray()
    const claimed: {
      chatId: number; messageId: number; targetUserId: number; promptMessageId: number | null
    }[] = []
    for (const doc of due) {
      const chatId = Number(doc['chatId'])
      const messageId = Number(doc['messageId'])
      const result = await this.votes.updateOne(
        { chatId, messageId, status: 'open' },
        { $set: { status: 'expired', closedAt: new Date() } }
      )
      if (result.modifiedCount !== 1) continue
      const prompt = doc['promptMessageId']
      claimed.push({
        chatId,
        messageId,
        targetUserId: Number(doc['targetUserId'] ?? 0),
        promptMessageId: typeof prompt === 'number' ? prompt : null
      })
    }
    return claimed
  }

  /** Close atomically — only one caller wins, so resolution actions run once. */
  async closeVote(chatId: number, messageId: number, outcome: 'spam' | 'ham'): Promise<boolean> {
    const result = await this.votes.updateOne(
      { chatId, messageId, status: 'open' },
      { $set: { status: outcome, closedAt: new Date() } }
    )
    return result.modifiedCount === 1
  }

  /**
   * Settings-panel writes. Maps v2 panel state onto the v1-compatible
   * fields that groupDocToChatPolicy reads back, so v1 and v2 stay in sync.
   */
  async updateGroupSettings(chatId: number, patch: {
    enabled?: boolean
    confidenceThreshold?: number
    captchaEnabled?: boolean
    votingEnabled?: boolean
    banDatabase?: boolean
    bananDefault?: number
    locale?: string
  }): Promise<void> {
    const set: Record<string, unknown> = {}
    if (patch.enabled !== undefined) set['settings.openaiSpamCheck.enabled'] = patch.enabled
    if (patch.confidenceThreshold !== undefined) set['settings.openaiSpamCheck.confidenceThreshold'] = patch.confidenceThreshold
    if (patch.captchaEnabled !== undefined) set['settings.captcha.enabled'] = patch.captchaEnabled
    if (patch.votingEnabled !== undefined) set['settings.voting.enabled'] = patch.votingEnabled
    if (patch.banDatabase !== undefined) set['settings.banDatabase'] = patch.banDatabase
    if (patch.bananDefault !== undefined) set['settings.banan.default'] = patch.bananDefault
    if (patch.locale !== undefined) set['settings.locale'] = patch.locale
    if (Object.keys(set).length === 0) return
    await this.groups.updateOne(
      { group_id: chatId },
      { $set: set, $setOnInsert: { group_id: chatId } },
      { upsert: true }
    )
  }

  /**
   * Admin override ("не спам"). The closed feedback loop: the label is
   * stored permanently AND the offending knowledge is deactivated so the
   * same FP cannot repeat tomorrow.
   *
   * The label now keeps the EVIDENCE that produced it (2026-07-31), not just a
   * pointer to how the verdict was reached. It used to store `decidedBy`,
   * `ruleId` and `reasonCode` only, while the signals and the score lived in
   * `pipeline_decisions` — which expires after 14 days. So a permanent
   * "this was a false positive" became unusable two weeks later: there was no
   * way left to ask whether a weight change would have prevented it. Every
   * calibration decision since has therefore rested on the single incident that
   * prompted it, with nothing to check it against.
   *
   * Cost is a few dozen bytes on a document written only when an admin clicks a
   * button, which matters because the cluster is size-constrained: this is the
   * cheapest record in the system and the only one that carries ground truth.
   */
  async recordOverride(params: {
    chatId: number
    messageId: number
    userId: number
    adminId: number
    /**
     * Who overturned the verdict. Both are corrections worth calibrating
     * against, and they are recorded side by side so replay can weigh them
     * differently — but only one of them may reach into the shared signature
     * table (see below). Defaults to `admin` for callers written before a
     * community vote could get here.
     */
    source?: 'admin' | 'community_vote'
    /**
     * How many of the sender's messages this verdict removed, the triggering one
     * included — omitted when we no longer know.
     *
     * The one cost of a mistake that a correction cannot undo. Lifting a ban and
     * returning standing are reversible; a deleted message is gone, and since a
     * verdict may now take a whole run of them down at once, a ground-truth set
     * that counts every mistake as costing one message would understate exactly
     * the mistakes that cost the most.
     */
    removedCount?: number
    verdict: Pick<Verdict, 'decidedBy' | 'ruleId' | 'reasonCode' | 'pSpam' | 'action' | 'signals' | 'meta'>
  }): Promise<void> {
    const source = params.source ?? 'admin'
    /**
     * One message, one label — an upsert, not an insert.
     *
     * A double tap on the button used to write the correction twice: 2026-08-07
     * the store held 61 documents for 52 distinct messages, one pair seven
     * seconds apart from the same admin. That is not a cosmetic duplicate. This
     * collection IS the ground-truth set: every false-positive rate in the audit
     * is a count over it, and calibration reads it as one row per mistake. A
     * message reversed twice was silently worth double, which biases weights
     * toward whichever verdict an admin happened to tap twice.
     *
     * Keyed on the message rather than on (message, admin): the unit of truth is
     * "this message was not spam", and two admins agreeing is not two mistakes.
     * `$setOnInsert` keeps `createdAt` at the FIRST correction — the honest
     * timestamp for when we learned we were wrong.
     */
    await this.feedback.updateOne({ chatId: params.chatId, messageId: params.messageId }, {
      $setOnInsert: { createdAt: new Date() },
      $set: {
        kind: 'override_not_spam',
        source,
        chatId: params.chatId,
        messageId: params.messageId,
        userId: params.userId,
        adminId: params.adminId,
        decidedBy: params.verdict.decidedBy,
        ruleId: params.verdict.ruleId,
        reasonCode: params.verdict.reasonCode,
        // The feature vector: enough to recompute the score and both enforcement
        // guards offline, from the catalogue as it stands whenever we next ask.
        pSpam: params.verdict.pSpam,
        action: params.verdict.action,
        signals: params.verdict.signals.map((s) => s.name),
        ...(params.removedCount !== undefined ? { removedCount: params.removedCount } : {}),
        // `scorePSpam` / `contentEvidence` / `cappedGroups` are what make the
        // arithmetic reproducible when the verdict came from a port or the LLM.
        meta: params.verdict.meta
      }
    }, { upsert: true })

    // Deactivate the matched signature so it never fires again — an admin
    // decision only. A signature fires in every chat for the next ninety days,
    // so retiring one is a network-wide act, and a chat's own ballot is not
    // authority over the network: a crew posting spam in a group they control
    // could otherwise vote their own text clean and take the rule down
    // everywhere. Community ham is recorded above and calibrated offline, which
    // is the honest weight for it.
    if (source === 'admin' && params.verdict.decidedBy === 'signature' && params.verdict.ruleId) {
      await this.spamSignatures.updateOne(
        { _id: asObjectIdMaybe(params.verdict.ruleId) ?? params.verdict.ruleId as never },
        { $set: { status: 'candidate', disabledAt: new Date(), disabledBy: 'admin_override' } }
      ).catch(() => { /* a missing signature is fine */ })
    }
  }
}

/** Signature ruleIds are stringified Mongo _ids. */
const asObjectIdMaybe = (id: string): ObjectId | null =>
  ObjectId.isValid(id) ? new ObjectId(id) : null
