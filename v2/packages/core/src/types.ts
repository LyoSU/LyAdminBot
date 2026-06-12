/**
 * Core domain types. The contract between adapters (mtcute/Mongo) and the
 * pipeline.
 *
 * Package invariant: no imports from mtcute, Mongo, or network clients —
 * everything the pipeline needs arrives in these structures. This is what
 * makes the core replayable offline against production logs.
 */

// ───────────────────────── input ─────────────────────────

export type ChatKind = 'group' | 'discussion'

export interface NormalizedChat {
  id: number
  kind: ChatKind
  title: string
  /** Dominant chat language (top-1, ≥10 samples), null until known. */
  topLanguage: string | null
}

/** Telegram-level sender flags. Free with every MTProto update. */
export interface SenderFlags {
  scam: boolean
  fake: boolean
  restricted: boolean
  verified: boolean
  premium: boolean
  bot: boolean
}

export interface UserSnapshot {
  id: number
  username: string | null
  displayName: string
  languageCode: string | null
  flags: SenderFlags
  /** Account age estimated from the ID range, in days. Null — unknown. */
  predictedAgeDays: number | null
  /** Local history: how many days ago we first saw this account. */
  localAgeDays: number | null
  /** Messages in THIS chat (including the current one). */
  messagesInChat: number
  /** Messages globally across all chats the bot sees. */
  messagesGlobal: number
  groupsActive: number
  spamDetections: number
  reputationScore: number // 0..100
  reputationStatus: 'restricted' | 'suspicious' | 'neutral' | 'trusted'
  /** External ban databases (lols/cas), null — not checked. */
  externalBan: { banned: boolean; spamFactor: number } | null
  /**
   * Telegram server flagged this user as a security risk for using an
   * unofficial client (userFull.unofficial_security_risk). Strongest
   * single account marker we have. Null — profile not enriched yet.
   */
  unofficialClientRisk: boolean | null
  /** Enrichment (may be missing — budget/failure): avatar history. */
  avatars: { count: number; latestSetDaysAgo: number | null } | null
  /** Identity-churn counters over the last 24h. */
  nameChurn24h: number
  usernameChurn24h: number
}

/** A mention from the message after resolution (adapters/enrich). */
export interface ResolvedMention {
  username: string
  kind: 'user' | 'bot' | 'channel' | 'group' | 'unknown'
  /** For channels: roughly new/small, when we could tell. */
  isNewish: boolean | null
}

export interface MessageAttachmentInfo {
  kind:
    | 'photo' | 'video' | 'animation' | 'sticker' | 'voice'
    | 'video_note' | 'audio' | 'document' | 'contact' | 'poll'
    | 'story' | 'location'
    // Newer TL media that carry spam-relevant semantics on their own:
    // paid media hides content until payment, giveaways/streams are promo
    // vectors, todo checklists carry classifiable task texts.
    | 'paid_media' | 'giveaway' | 'todo' | 'video_stream' | 'invoice'
    // Unknown TL constructor — normalizer must never drop media silently.
    | 'unknown'
  fileUniqueId: string | null
}

export interface InlineButtonInfo {
  text: string
  url: string | null
}

/** One line of the conversation window (LLM context). */
export interface ConversationLine {
  authorKind: 'user' | 'admin' | 'channel_post'
  textPreview: string // ≤ 120 chars
}

export interface NormalizedMessage {
  chatId: number
  messageId: number
  threadId: number | null
  /** unix seconds (Telegram server time) */
  date: number
  isEdit: boolean
  text: string
  /** Raw URLs from text and entities (including hidden text_link). */
  urls: { visible: string; target: string; hidden: boolean }[]
  mentions: string[]
  attachments: MessageAttachmentInfo[]
  inlineButtons: InlineButtonInfo[]
  forward: { kind: 'user' | 'hidden_user' | 'channel' | 'chat'; title: string | null } | null
  replyTo: { authorId: number | null; isSelf: boolean; ageSeconds: number | null; textPreview: string | null } | null
  /** Comment under a channel post (discussion group). */
  channelComment: { channelTitle: string | null; postPreview: string | null } | null
  /** Edit delta when isEdit: what got injected. */
  editDelta: { injectedUrls: number; injectedMentions: number; injectedInvisibles: number } | null
  /**
   * Custom emoji entities. `alt` is the fallback character the emoji
   * renders over — spammers mask phone numbers / channel names this way,
   * so the alt sequence is part of the classifiable content.
   */
  customEmoji: { id: string; alt: string }[]
  /**
   * Present when the message was delivered by a guest bot (a bot summoned
   * by mention into a chat it is not a member of). The caller is the user
   * who summoned it — moderation targets the content and the caller, never
   * bot-ness itself (guest bots are often legitimate).
   */
  guestBot: { botId: number; botUsername: string | null; callerId: number | null } | null
}

/** Enrichment result — everything optional: the call budget may run out. */
export interface Enrichment {
  bio: string | null
  resolvedMentions: ResolvedMention[]
  conversationWindow: ConversationLine[]
  /** Message photo, when present and downloaded (for LLM vision). */
  photoBase64: string | null
}

// ─────────────────────── chat policy ───────────────────────

export type StrictnessPreset = 'soft' | 'standard' | 'strict'

export interface ChatPolicy {
  enabled: boolean
  preset: StrictnessPreset
  captchaEnabled: boolean
  votingEnabled: boolean
  reactionModeration: boolean
  customRules: string[] // "ALLOW: ..." / "DENY: ..."
  trustedUserIds: number[]
}

// ───────────────────────── signals ─────────────────────────

/**
 * A signal is a fact, not a verdict. `name` is a stable identifier
 * (the key for calibration and FP telemetry), `evidence` is a
 * human-readable explanation for the expanded "Why?" view.
 */
export interface Signal {
  name: string
  /** Trust signals carry negative: true. */
  negative?: boolean
  evidence?: string
}

// ───────────────────────── verdict ─────────────────────────

export type VerdictAction =
  | 'none'      // clean message
  | 'observe'   // abstain: not enough data, accumulate the session
  | 'captcha'   // soft gate for a suspicious newcomer
  | 'delete'    // delete the message
  | 'mute'      // mute + delete
  | 'ban'       // ban + purge messages

export type DecidedBy =
  | 'custom_rule'
  | 'deterministic'   // rule with measured precision
  | 'signature'
  | 'vector'
  | 'velocity'
  | 'moderation'      // OpenAI moderation (NSFW)
  | 'llm'
  | 'llm_cached'
  | 'session'         // session scoring of the accumulated buffer
  | 'score'           // weighted signal score without LLM involvement
  | 'abstain'
  | 'error'

export interface Verdict {
  /** Calibrated spam probability, 0..1. */
  pSpam: number
  action: VerdictAction
  /** Whether to create a community vote event. */
  needsVote: boolean
  decidedBy: DecidedBy
  /** Rule/pattern identifier — feeds the feedback loop. */
  ruleId: string | null
  signals: Signal[]
  /** Reason code localized by the ui layer; NEVER raw LLM text. */
  reasonCode: string
  /** Optional evidence quote (text fragment / link) for the "Why?" view. */
  reasonEvidence: string | null
  /** Metadata for pipeline_decisions (latency, model, etc.). */
  meta: Record<string, string | number | boolean>
}

// ─────────────────── full pipeline input ───────────────────

export interface EvaluationInput {
  message: NormalizedMessage
  chat: NormalizedChat
  user: UserSnapshot
  policy: ChatPolicy
  enrichment: Enrichment
}
