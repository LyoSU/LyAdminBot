/**
 * Mongo store: same database and collections as v1 (byte-compatible,
 * additive-only). New collections introduced by v2:
 *   pipeline_decisions — every verdict, TTL 90d (replay + calibration)
 *   pipeline_feedback  — admin overrides, permanent (ham labels)
 *   llm_cache          — LLM verdict cache, TTL 7d
 */
import { MongoClient, ObjectId, type Collection, type Db, type Document } from 'mongodb'
import type { Verdict } from '@lyadmin/core'
import { normalizeExtra, type NormalizedExtra } from './extras.js'

const DECISIONS_TTL_DAYS = 90
const LLM_CACHE_TTL_DAYS = 7

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
  get modEvents(): Collection<Document> { return this.collection('modevents') }
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

  private async ensureIndexes(): Promise<void> {
    await this.decisions.createIndex({ createdAt: 1 }, { expireAfterSeconds: DECISIONS_TTL_DAYS * 86400 })
    await this.decisions.createIndex({ chatId: 1, userId: 1, createdAt: -1 })
    // Why?/override lookup (getDecision) filters by chat+message.
    await this.decisions.createIndex({ chatId: 1, messageId: 1, createdAt: -1 })
    await this.feedback.createIndex({ chatId: 1, messageId: 1 })
    await this.llmCache.createIndex({ createdAt: 1 }, { expireAfterSeconds: LLM_CACHE_TTL_DAYS * 86400 })
    await this.llmCache.createIndex({ key: 1 }, { unique: true })
    await this.votes.createIndex({ chatId: 1, messageId: 1 }, { unique: true })
    await this.votes.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 86400 })
    // Scheduled deletions: single deleteAt index doubles as the due-query
    // index and a 1h TTL backstop (3600s after deleteAt) if a sweep is missed.
    await this.scheduledDeletions.createIndex({ deleteAt: 1 }, { expireAfterSeconds: 3600 })
    // Velocity/session windows expire to bound growth and define the window:
    // 10 min for the flood window, 30 min for the abstain session.
    await this.velocityEvents.createIndex({ firstSeenAt: 1 }, { expireAfterSeconds: 600 })
    await this.sessionWindows.createIndex({ startedAt: 1 }, { expireAfterSeconds: 1800 })
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

  /** Member stats for /mystats (reads the same doc touchMember maintains). */
  async getMemberStats(chatId: number, telegramId: number): Promise<{ messagesCount: number; bananCount: number }> {
    const group = await this.groups.findOne({ group_id: chatId }, { projection: { _id: 1 } })
    if (!group) return { messagesCount: 0, bananCount: 0 }
    const member = await this.groupMembers.findOne(
      { group: group['_id'], telegram_id: telegramId },
      { projection: { 'stats.messagesCount': 1, 'banan.num': 1 } }
    ) as { stats?: { messagesCount?: number }; banan?: { num?: number } } | null
    return {
      messagesCount: member?.stats?.messagesCount ?? 0,
      bananCount: member?.banan?.num ?? 0
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

  /** Per-message extra cap (v1 settings.maxExtra, default 1). */
  async getMaxExtra(chatId: number): Promise<number> {
    const group = await this.groups.findOne(
      { group_id: chatId },
      { projection: { 'settings.maxExtra': 1 } }
    ) as { settings?: { maxExtra?: number } } | null
    const n = Number(group?.settings?.maxExtra)
    return Number.isFinite(n) && n > 0 ? n : 1
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

  /** Set a single welcome text (with %name%) and enable greetings. */
  async setWelcomeText(chatId: number, text: string): Promise<void> {
    await this.groups.updateOne(
      { group_id: chatId },
      { $set: { 'settings.welcome.texts': [text], 'settings.welcome.enable': true }, $setOnInsert: { group_id: chatId } },
      { upsert: true }
    )
  }

  /** Set a single welcome gif/animation (file id) and enable greetings. */
  async setWelcomeGif(chatId: number, fileId: string): Promise<void> {
    await this.groups.updateOne(
      { group_id: chatId },
      { $set: { 'settings.welcome.gifs': [fileId], 'settings.welcome.enable': true }, $setOnInsert: { group_id: chatId } },
      { upsert: true }
    )
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
    lookup: { lols: object | null; cas: object | null }
  ): Promise<void> {
    const set: Record<string, unknown> = {}
    if (lookup.lols) set['externalBan.lols'] = lookup.lols
    if (lookup.cas) set['externalBan.cas'] = lookup.cas
    if (Object.keys(set).length === 0) return
    await this.users.updateOne({ telegram_id: telegramId }, { $set: set }, { upsert: true })
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
   * Returns the message count BEFORE this message — that is what the
   * "new in chat" signal must see.
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
        $inc: { 'stats.messagesCount': 1, 'stats.textTotal': Math.max(0, textLength) }
      },
      { upsert: true, returnDocument: 'before', projection: { 'stats.messagesCount': 1 } }
    )
    return (before as { stats?: { messagesCount?: number } } | null)?.stats?.messagesCount ?? 0
  }

  async recordDecision(params: {
    chatId: number
    userId: number
    messageId: number
    textPreview: string
    verdict: Verdict
    latencyMs: number
  }): Promise<void> {
    await this.decisions.insertOne({
      chatId: params.chatId,
      userId: params.userId,
      messageId: params.messageId,
      textPreview: params.textPreview.slice(0, 200),
      pSpam: params.verdict.pSpam,
      action: params.verdict.action,
      decidedBy: params.verdict.decidedBy,
      ruleId: params.verdict.ruleId,
      reasonCode: params.verdict.reasonCode,
      signals: params.verdict.signals.map((s) => s.name),
      needsVote: params.verdict.needsVote,
      meta: params.verdict.meta,
      latencyMs: params.latencyMs,
      createdAt: new Date()
    })
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
      decidedBy: (doc['decidedBy'] ?? 'error') as Verdict['decidedBy'],
      ruleId: (doc['ruleId'] as string | null) ?? null,
      signals: signalNames.map((n) => ({ name: String(n) })),
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
    try {
      await this.votes.insertOne({
        chatId: params.chatId,
        messageId: params.messageId,
        targetUserId: params.targetUserId,
        targetLabel: params.targetLabel.slice(0, 64),
        textPreview: params.textPreview.slice(0, 200),
        learnText: (params.learnText ?? params.textPreview).slice(0, 1000),
        openedBy: params.openedBy,
        promptMessageId: null,
        ballots: [],
        status: 'open',
        createdAt: new Date()
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
  }): Promise<void> {
    const ballot = { userId: params.userId, isAdmin: params.isAdmin, choice: params.choice, at: new Date() }
    await this.votes.updateOne(
      { chatId: params.chatId, messageId: params.messageId, status: 'open' },
      // The driver's PushOperator<Document> rejects concrete array elements.
      { $push: { ballots: ballot } } as never
    )
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
  }): Promise<void> {
    const set: Record<string, unknown> = {}
    if (patch.enabled !== undefined) set['settings.openaiSpamCheck.enabled'] = patch.enabled
    if (patch.confidenceThreshold !== undefined) set['settings.openaiSpamCheck.confidenceThreshold'] = patch.confidenceThreshold
    if (patch.captchaEnabled !== undefined) set['settings.captcha.enabled'] = patch.captchaEnabled
    if (patch.votingEnabled !== undefined) set['settings.voting.enabled'] = patch.votingEnabled
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
   */
  async recordOverride(params: {
    chatId: number
    messageId: number
    userId: number
    adminId: number
    verdict: Pick<Verdict, 'decidedBy' | 'ruleId' | 'reasonCode'>
  }): Promise<void> {
    await this.feedback.insertOne({
      kind: 'override_not_spam',
      chatId: params.chatId,
      messageId: params.messageId,
      userId: params.userId,
      adminId: params.adminId,
      decidedBy: params.verdict.decidedBy,
      ruleId: params.verdict.ruleId,
      reasonCode: params.verdict.reasonCode,
      createdAt: new Date()
    })

    // Deactivate the matched signature so it never fires again.
    if (params.verdict.decidedBy === 'signature' && params.verdict.ruleId) {
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
