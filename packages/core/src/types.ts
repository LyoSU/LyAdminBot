/**
 * Core domain types. The contract between adapters (mtcute/Mongo) and the
 * pipeline.
 *
 * Package invariant: no imports from mtcute, Mongo, or network clients —
 * everything the pipeline needs arrives in these structures. This is what
 * makes the core replayable offline against production logs.
 */
import type { SignalName } from './signals/registry.js'

// ───────────────────────── input ─────────────────────────

export type ChatKind = 'group' | 'discussion'

export interface NormalizedChat {
  id: number
  kind: ChatKind
  title: string
  /** Dominant chat language (top-1, ≥10 samples), null until known. */
  topLanguage: string | null
  /**
   * The chat's own description, as its admins wrote it — what the chat is FOR.
   *
   * The title alone turned out to be too little (production 2026-07-31): in a
   * chat whose purpose is job advertisements, "job scam" is simultaneously the
   * dominant spam class and the dominant legitimate class, and a specific local
   * job ad was classified as a scam at 0.96. Whether being an advertisement is
   * itself unusual depends on what the chat is for, and nothing in the pipeline
   * knew that.
   *
   * Admin-authored, therefore UNTRUSTED wherever it is rendered. Null when the
   * chat has none or the lookup failed.
   */
  description: string | null
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

/** Which third-party database listed an account. */
export type ExternalBanSource = 'lols' | 'cas'

export interface ExternalBanFacts {
  banned: boolean
  bannedAt: Date | null
  offenses: number
  /**
   * The sources that actually say "banned", not the ones merely consulted.
   *
   * Kept because `external_ban_new` is the most consequential deterministic
   * action there is — a 30-day ban on a third party's word, with no evidence
   * from the message required or examined — and until 2026-07-31 neither the
   * log nor the signal recorded who had made the accusation. The two databases
   * do not have the same false-positive profile, so "should we believe this
   * listing" was unanswerable exactly where the answer mattered.
   */
  sources: ExternalBanSource[]
}

export interface UserSnapshot {
  id: number
  username: string | null
  displayName: string
  languageCode: string | null
  flags: SenderFlags
  /** Account age estimated from the ID range, in days. Null — unknown. */
  predictedAgeDays: number | null
  /**
   * Uncertainty interval around predictedAgeDays. `lo` — youngest plausible
   * age, `hi` — oldest plausible. Conservative gating: fresh requires hi
   * under the threshold, sleeper requires lo over it. Null — unknown (then
   * the point estimate stands in for both bounds).
   */
  predictedAgeBoundsDays: { lo: number; hi: number } | null
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
  /**
   * External ban databases (lols/cas), null — not checked. `bannedAt` is when
   * the source added the ban (recency factor); `offenses` is the CAS repeat
   * count (lols contributes 1).
   */
  externalBan: ExternalBanFacts | null
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
  /**
   * Telegram restriction_reason codes (free with the user object), e.g.
   * ['spam']. Empty when the account is unrestricted or the field is absent.
   */
  restrictionReasons: string[]
  /**
   * Seconds since the user joined THIS chat (channels.getParticipant.date),
   * null when unknown (not fetched / not a member record). A tiny value means
   * "joined and immediately posted".
   */
  joinedAgoSeconds: number | null
  /**
   * Whether Telegram says they are in this chat: false only when it said so by
   * name, null when it did not say. See `MemberFacts.isParticipant`.
   */
  isParticipant?: boolean | null
  /** True while this member's recorded join belongs to a detected chat surge. */
  joinedDuringSurge?: boolean
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
  /**
   * Telegram id of the author — lets the LLM prompt distinguish the sender
   * under review from other members. Null for channel posts (no user author).
   */
  authorId: number | null
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
  /** sourceId: numeric origin id when Telegram exposes it (hidden users have none). */
  forward: { kind: 'user' | 'hidden_user' | 'channel' | 'chat'; title: string | null; sourceId?: number | null } | null
  replyTo: { authorId: number | null; isSelf: boolean; ageSeconds: number | null; textPreview: string | null } | null
  /** Comment under a channel post (discussion group). */
  channelComment: { channelTitle: string | null; postPreview: string | null } | null
  /**
   * Edit delta when isEdit: what got injected.
   *
   * Null means nobody remembers the earlier version, NOT that nothing changed —
   * the edit signals therefore read the counts and never the `isEdit` flag.
   */
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

/**
 * What is remembered about a message so that a later EDIT of it can be
 * measured — the input to `NormalizedMessage.editDelta`.
 *
 * Counters, not the message. Edit-to-inject is the one spam shape whose
 * evidence exists only as a DIFFERENCE between two deliveries, so somebody has
 * to hold the earlier one; holding whole normalizations of every recent message
 * would be a cache nobody sized, and the store would have to carry them too.
 * These three numbers are the entire question the delta asks, they are cheap
 * enough to keep for every message in flight, and small enough to ride along in
 * the decision record — which is what makes the resulting verdict reproducible
 * offline, the same requirement the burst window is held to.
 */
/**
 * What the executor managed to do about a verdict, as stored beside it.
 *
 * Declared here rather than beside `applyVerdict` for the same reason
 * `EditBaseline` is: the store writes it and the store cannot import the
 * adapter package. It mirrors `ExecutionResult` minus the parts that mean
 * nothing after the fact (the captcha prompt the app layer still owes) and
 * minus the raw error strings, which are Telegram's own and unbounded.
 */
export interface ExecutionRecord {
  /** The action the verdict named — for a removal, what happened to the sender. */
  applied: boolean
  /** The message itself; null when the action never removes one. */
  deleted: boolean | null
  /** Why nothing was attempted: `senderIsAdmin`, `senderIsSelf`, `senderIsTrusted`. */
  skippedReason: string | null
  /** Labels of the calls that threw — `delete`, `ban`, `mute`, `kick`. */
  failed: string[]
  /** Other parts of the same album removed with it. */
  albumRemoved: number
  /** Earlier messages of the same run swept when the sender went. */
  retroPurged: number
}

export interface EditBaseline {
  urls: number
  mentions: number
  invisibles: number
  /**
   * Identity of the links the earlier version carried — short digests, capped.
   *
   * Counts alone cannot see the attack they were meant to catch: swapping one
   * benign link for a promo one leaves the count unchanged, so a delta computed
   * from lengths reports nothing injected. With keys, "injected" means a
   * destination that was not there before, which is what the word claims.
   *
   * Absent when the earlier version carried more links than the cap, and on
   * records written before this field existed — both fall back to the counts,
   * which under-detect rather than over-detect.
   */
  urlKeys?: string[]
}

/** Enrichment result — everything optional: the call budget may run out. */
/**
 * What a channel the sender points at turns out to be.
 *
 * The account links somewhere — from the profile's personal-channel field, or
 * from a `t.me/…` in the bio — and this is what is on the other end. It is
 * still information about the SENDER, never about the message: a channel whose
 * description is a price list makes the account a promo vehicle, not this
 * particular sentence an advert.
 */
export interface ChannelPreview {
  /**
   * How we came to look, and — the part that decides everything downstream —
   * whether what we found is a fact about the ACCOUNT or about the MESSAGE.
   *
   * The first two are the account: a profile that advertises is a reason to
   * read the message closely and never by itself a reason to act on it. The
   * third is the message: where a link in THIS text leads is what the text is
   * doing, so it may be evidence.
   */
  source: 'personal_channel' | 'bio_link' | 'message_link'
  title: string
  /** The channel's own description, when it has one. */
  description: string | null
  subscribers: number | null
  /** The channel's picture as base64, when downloaded, for NSFW screening. */
  avatarBase64: string | null
}

export interface Enrichment {
  bio: string | null
  /**
   * Free text the account wrote about itself that is not the bio: the Telegram
   * Business intro, greeting and away messages.
   *
   * Premium-only, so usually empty — high precision, low recall. But a greeting
   * auto-sent to everyone who writes in is the same kind of unmoderated
   * self-description as the bio and reads the same way, so it is scored the
   * same way.
   */
  businessTexts: string[]
  /** userFull.personal_channel_id — a channel the user linked to their profile. */
  personalChannelId: number | null
  /** Whatever the account points at, resolved. See `ChannelPreview`. */
  linkedChannels: ChannelPreview[]
  resolvedMentions: ResolvedMention[]
  conversationWindow: ConversationLine[]
  /** Message photo, when present and downloaded (for LLM vision). */
  photoBase64: string | null
  /**
   * Sender's current avatar as base64, downloaded for NSFW moderation.
   * Only populated for newish senders (the gate that makes nsfw_avatar a
   * new-account signal by construction). Null when absent or download failed.
   */
  avatarBase64: string | null
  /**
   * Up to 3 active stories of the sender as base64, for NSFW moderation.
   * Best-effort: stories are a user-only MTProto surface, so on a bot account
   * this is usually empty and nsfw_stories simply never fires.
   */
  storyBase64: string[]
  /**
   * Perceptual hash of the sender's CURRENT profile photo, or null.
   *
   * The current one only, and that is the point rather than a limitation. The
   * dominant pattern in this class is a stolen account with its photograph
   * replaced: the old pictures belong to the real owner and say nothing about
   * whoever is operating it now, while the new one is the campaign's.
   *
   * Computed in the adapter layer, because hashing needs a JPEG decoder and the
   * core stays free of both IO and dependencies.
   */
  avatarDhash?: string | null
}

// ─────────────────────── chat policy ───────────────────────

export type StrictnessPreset = 'soft' | 'standard' | 'strict'

export interface ChatPolicy {
  enabled: boolean
  preset: StrictnessPreset
  captchaEnabled: boolean
  /**
   * Whether this deployment can whisper the captcha to one member (Bot API
   * 10.2 ephemeral messages). A capability of the running bot, not a chat
   * setting — the composition root fills it in; absent means "assume not".
   */
  ephemeralCaptcha?: boolean
  votingEnabled: boolean
  /** Honour external ban databases (lols/CAS); v1 `settings.banDatabase`. */
  externalBanEnabled: boolean
  customRules: string[] // "ALLOW: ..." / "DENY: ..."
  trustedUserIds: number[]
}

// ───────────────────────── signals ─────────────────────────

/**
 * A signal is a fact, not a verdict. `name` identifies it in the catalogue
 * (`signals/registry.ts`), which is also where its weight and its role live;
 * `evidence` is the human-readable detail for the expanded "Why?" view.
 *
 * Whether a signal accuses or exonerates is NOT stored here. It used to be, as
 * `negative: true` at each raise site, which made it a second source of truth
 * for something the catalogue already knows — and one that a verdict rebuilt
 * from a stored decision could not carry at all, since only the names are
 * persisted. Ask `isTrustSignal(name)` instead.
 */
export interface Signal {
  name: SignalName
  evidence?: string
}

// ───────────────────────── verdict ─────────────────────────

export type VerdictAction =
  | 'none'      // clean message
  | 'observe'   // abstain: not enough data, accumulate the session
  | 'captcha'   // soft gate for a suspicious newcomer
  | 'delete'    // delete the message
  | 'kick'      // delete + remove from the chat, but they may rejoin
  | 'mute'      // delete + restrict sending for a fixed window
  | 'ban'       // delete + ban (timed for newcomers, permanent on hard grounds)

export type DecidedBy =
  | 'custom_rule'
  | 'deterministic'   // rule with measured precision
  | 'forward'         // blacklisted forward source
  | 'signature'
  | 'vector'
  | 'velocity'
  | 'moderation'      // OpenAI moderation (NSFW)
  | 'llm'
  | 'llm_cached'
  | 'session'         // session scoring of the accumulated buffer
  | 'burst'           // classification of a sender's run of recent messages
  | 'score'           // weighted signal score without LLM involvement
  /**
   * A gate that was asked and not answered. Not a judgement of the message —
   * nothing read it — but it is an action taken against a member, and until
   * 2026-08-25 it was the only one this pipeline took that left no record
   * anywhere but a log line.
   */
  | 'captcha_ignored'
  /**
   * The door, not the conversation: a joiner stopped on what their profile
   * shows before they have said anything. Named apart from every judge above
   * because no message existed to judge.
   */
  | 'join_screen'
  | 'abstain'
  | 'error'

export interface Verdict {
  /** Calibrated spam probability, 0..1. */
  pSpam: number
  action: VerdictAction
  /** Whether to create a community vote event. */
  needsVote: boolean
  /**
   * Ban length in seconds when `action === 'ban'`; null means permanent.
   * Ignored for every other action.
   */
  banDurationSeconds: number | null
  decidedBy: DecidedBy
  /** Rule/pattern identifier — feeds the feedback loop. */
  ruleId: string | null
  signals: Signal[]
  /**
   * Ask the sender to prove they are human, alongside whatever `action` says.
   * Set when the pipeline had to act on an uncertain verdict: the message is
   * removed, but the *person* gets a way to clear themselves instead of being
   * removed too. `action: 'captcha'` is the standalone form; this is the
   * modifier that rides along with `delete`.
   */
  requireCaptcha?: boolean
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
