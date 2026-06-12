/**
 * Mongo store: same database and collections as v1 (byte-compatible,
 * additive-only). New collections introduced by v2:
 *   pipeline_decisions — every verdict, TTL 90d (replay + calibration)
 *   pipeline_feedback  — admin overrides, permanent (ham labels)
 *   llm_cache          — LLM verdict cache, TTL 7d
 */
import { MongoClient, ObjectId, type Collection, type Db, type Document } from 'mongodb'
import type { Verdict } from '@lyadmin/core'

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

  // v2 collections
  get decisions(): Collection<Document> { return this.collection('pipeline_decisions') }
  get feedback(): Collection<Document> { return this.collection('pipeline_feedback') }
  get llmCache(): Collection<Document> { return this.collection('llm_cache') }
  get votes(): Collection<Document> { return this.collection('pipeline_votes') }

  private async ensureIndexes(): Promise<void> {
    await this.decisions.createIndex({ createdAt: 1 }, { expireAfterSeconds: DECISIONS_TTL_DAYS * 86400 })
    await this.decisions.createIndex({ chatId: 1, userId: 1, createdAt: -1 })
    await this.feedback.createIndex({ chatId: 1, messageId: 1 })
    await this.llmCache.createIndex({ createdAt: 1 }, { expireAfterSeconds: LLM_CACHE_TTL_DAYS * 86400 })
    await this.llmCache.createIndex({ key: 1 }, { unique: true })
    await this.votes.createIndex({ chatId: 1, messageId: 1 }, { unique: true })
    await this.votes.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 86400 })
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

  // ── community votes (survive restarts; TTL 7d like modevents) ─────────

  /** Open a vote. Returns false when one already exists for this message. */
  async openVote(params: {
    chatId: number
    messageId: number
    targetUserId: number
    targetLabel: string
    textPreview: string
    openedBy: number
  }): Promise<boolean> {
    try {
      await this.votes.insertOne({
        chatId: params.chatId,
        messageId: params.messageId,
        targetUserId: params.targetUserId,
        targetLabel: params.targetLabel.slice(0, 64),
        textPreview: params.textPreview.slice(0, 200),
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
