/**
 * Pure mappers: production Mongo documents (v1 mongoose shapes) → domain
 * types. Kept pure so byte-compatibility is testable without a database.
 */
import type {
  ChatPolicy, ExternalBanFacts, ExternalBanSource, StrictnessPreset
} from '@lyadmin/core'

/** Loose shape of the v1 `groups` document (only the fields we read). */
export interface GroupDoc {
  group_id: number
  settings?: {
    locale?: string
    /** v1 toggle for the external ban databases (lols/CAS). Default true. */
    banDatabase?: boolean
    /** Opt-in reaction-based moderation (off by default). */
    openaiSpamCheck?: {
      enabled?: boolean
      confidenceThreshold?: number
      customRules?: string[]
      trustedUsers?: number[]
    }
    captcha?: { enabled?: boolean }
    voting?: { enabled?: boolean }
  }
}

/**
 * v1 stored a 50..95 confidence slider; v2 uses presets. Mapping keeps the
 * spirit of each chat's current setting:
 *   <= 65  → strict   (they wanted aggressive filtering)
 *   <= 78  → standard (default 70 lands here)
 *   >  78  → soft     (they raised the bar to avoid FPs)
 */
export const thresholdToPreset = (threshold: number | undefined): StrictnessPreset => {
  if (threshold === undefined) return 'standard'
  if (threshold <= 65) return 'strict'
  if (threshold <= 78) return 'standard'
  return 'soft'
}

/**
 * Inverse write mapping: v2 preset → representative v1 slider value, so the
 * panel writes stay byte-compatible with v1 and round-trip through
 * thresholdToPreset.
 */
export const presetToThreshold = (preset: StrictnessPreset): number => {
  if (preset === 'strict') return 60
  if (preset === 'soft') return 85
  return 70
}

export const groupDocToChatPolicy = (doc: GroupDoc | null): ChatPolicy => {
  const spam = doc?.settings?.openaiSpamCheck
  return {
    enabled: spam?.enabled ?? true,
    preset: thresholdToPreset(spam?.confidenceThreshold),
    /**
     * On by default, unlike every other opt-in this bot has — and the only
     * default that was ever false, which is what made it dead code.
     *
     * Measured 2026-08-25 over 14 days and 239,528 verdicts: `action: 'captcha'`
     * occurred ZERO times, and `low_information_profile` — the reason code that
     * exists solely to ask an unreadable-but-suspicious sender to prove they are
     * human — was written zero times. Of 753 groups, one had this flag on. So
     * the whole branch below `decideAction`'s grey band, tests and all, had
     * never once run in production.
     *
     * Defaulting it true is safe in a way that no other enforcement default is:
     * a captcha removes nothing and bans nobody. It is delivered as an MTProto
     * ephemeral message that only its recipient can see, so a wrong guess costs
     * that member one tap and costs the chat nothing — no public accusation, no
     * deleted message. That asymmetry is the entire argument for asking instead
     * of acting, and it only pays off if asking is actually reachable.
     */
    captchaEnabled: doc?.settings?.captcha?.enabled ?? true,
    votingEnabled: doc?.settings?.voting?.enabled ?? true,
    externalBanEnabled: doc?.settings?.banDatabase ?? true,
    customRules: spam?.customRules ?? [],
    trustedUserIds: spam?.trustedUsers ?? []
  }
}

/** Loose shape of the v1 `users` document (only the fields we read). */
export interface UserDoc {
  telegram_id: number
  globalStats?: {
    totalMessages?: number
    groupsActive?: number
    firstSeen?: Date | string
    spamDetections?: number
    /**
     * Messages this account sent that the pipeline judged to be spam. Written
     * by `MongoStore.adjustSpamMessages` and subtracted from `totalMessages` to
     * get standing — see `userDocToHistory`. Absent on every document written
     * before 2026-07-31, which reads as zero.
     */
    spamMessages?: number
  }
  reputation?: {
    score?: number
    status?: 'trusted' | 'neutral' | 'suspicious' | 'restricted'
  }
  externalBan?: {
    lols?: ExternalBanSourceDoc
    cas?: ExternalBanSourceDoc
  }
  nameHistory?: { value?: string; seenAt?: Date | string }[]
  usernameHistory?: { value?: string; seenAt?: Date | string }[]
  /**
   * Mongoose `timestamps: true` wrote this on every v1 document, and it is the
   * only first-seen date the oldest ones carry — see `firstSeenUnix`.
   */
  createdAt?: Date | string
}

const CHURN_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * v1 semantics (helpers/spam-signals.js countRecentChanges): a single
 * seeded entry is a baseline, not a change; only histories with >= 2
 * entries count, and every entry inside the window counts as one event.
 */
export const countRecentChanges = (
  history: { seenAt?: Date | string }[] | undefined,
  nowMs = Date.now()
): number => {
  if (!Array.isArray(history) || history.length < 2) return 0
  const cutoff = nowMs - CHURN_WINDOW_MS
  let count = 0
  for (const entry of history) {
    const seenAt = entry?.seenAt ? new Date(entry.seenAt).getTime() : 0
    if (seenAt >= cutoff) count += 1
  }
  return count
}

export interface UserHistoryView {
  firstSeenUnix: number | null
  messagesInChat: number
  messagesGlobal: number
  groupsActive: number
  spamDetections: number
  reputationStatus: 'trusted' | 'neutral' | 'suspicious' | 'restricted'
  externalBan: ExternalBanFacts | null
  nameChurn24h: number
  usernameChurn24h: number
  avatars: { count: number; latestSetDaysAgo: number | null } | null
}

/** Per-source record persisted under user.externalBan.{lols,cas}. */
export interface ExternalBanSourceDoc {
  banned?: boolean
  bannedAt?: Date | string | null
  offenses?: number
  checkedAt?: Date | string
}

/** Sub-document shape persisted by the external ban-database lookups. */
export interface ExternalBanSubdoc {
  lols?: ExternalBanSourceDoc | null
  cas?: ExternalBanSourceDoc | null
}

const toDate = (v: Date | string | null | undefined): Date | null => {
  if (v === null || v === undefined) return null
  const d = new Date(v)
  return Number.isFinite(d.getTime()) ? d : null
}

/**
 * Collapse the per-source records into one domain value. banned is the OR of
 * both databases; offenses takes the strongest source's count; bannedAt is the
 * most recent listing (recency factor). Returns null when there is nothing to say.
 */
export const mergeExternalBan = (
  externalBan: ExternalBanSubdoc | null | undefined
): ExternalBanFacts | null => {
  const lols = externalBan?.lols
  const cas = externalBan?.cas
  const banned = Boolean(lols?.banned) || Boolean(cas?.banned)
  // Only the sources that say "banned". A source with an offense history but no
  // active listing has cleared the account, and counting it as an accuser would
  // make a rehabilitated account permanently guilty.
  const sources: ExternalBanSource[] = []
  if (lols?.banned) sources.push('lols')
  if (cas?.banned) sources.push('cas')
  const offenses = Math.max(lols?.offenses ?? 0, cas?.offenses ?? 0)
  const dates = [toDate(lols?.bannedAt), toDate(cas?.bannedAt)].filter((d): d is Date => d !== null)
  const bannedAt = dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null
  return banned || offenses > 0 ? { banned, bannedAt, offenses, sources } : null
}

const unixSeconds = (at: unknown): number | null => {
  if (typeof at !== 'string' && typeof at !== 'number' && !(at instanceof Date)) return null
  const ms = new Date(at).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/**
 * When our record of this account begins — the earlier of the two dates that
 * answer that, because they answer the same question and neither is always
 * there.
 *
 * `globalStats.firstSeen` is v1's own field, and a Mongoose default lands only
 * on insert: it entered the schema on 2026-01-07, so every account first
 * recorded before that day has counters that keep growing and no first-seen
 * date at all. Reading it alone therefore reported "we have never seen this
 * person" about the longest-standing members we have — and tenure is exactly
 * what protects them from the harsher action.
 *
 * `createdAt` is Mongoose's `timestamps: true`, present on every document v1
 * wrote and on none that v2 writes (the raw driver sets `firstSeen` instead).
 * The two are complementary, which is why this takes whichever is there and
 * the earlier one when both are.
 */
const firstSeenUnixOf = (doc: UserDoc): number | null => {
  const fromStats = unixSeconds(doc.globalStats?.firstSeen)
  const fromRecord = unixSeconds(doc.createdAt)
  if (fromStats === null) return fromRecord
  if (fromRecord === null) return fromStats
  return Math.min(fromStats, fromRecord)
}

export const userDocToHistory = (
  doc: UserDoc | null,
  messagesInChat: number,
  nowMs = Date.now()
): UserHistoryView | null => {
  if (!doc) return null
  const stats = doc.globalStats ?? {}
  return {
    firstSeenUnix: firstSeenUnixOf(doc),
    messagesInChat,
    // Standing, not traffic: messages the pipeline judged to be spam buy no
    // benefit of the doubt. `totalMessages` is incremented before the verdict
    // exists (the count is an input to it), so the subtraction has to happen
    // here — see `MongoStore.adjustSpamMessages`.
    messagesGlobal: Math.max(0, (stats.totalMessages ?? 0) - (stats.spamMessages ?? 0)),
    groupsActive: stats.groupsActive ?? 0,
    spamDetections: stats.spamDetections ?? 0,
    reputationStatus: doc.reputation?.status ?? 'neutral',
    externalBan: mergeExternalBan(doc.externalBan),
    nameChurn24h: countRecentChanges(doc.nameHistory, nowMs),
    usernameChurn24h: countRecentChanges(doc.usernameHistory, nowMs),
    avatars: null // avatars come from live enrichment, not Mongo
  }
}
