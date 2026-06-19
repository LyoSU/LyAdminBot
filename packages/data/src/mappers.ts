/**
 * Pure mappers: production Mongo documents (v1 mongoose shapes) → domain
 * types. Kept pure so byte-compatibility is testable without a database.
 */
import type { ChatPolicy, StrictnessPreset } from '@lyadmin/core'

/** Loose shape of the v1 `groups` document (only the fields we read). */
export interface GroupDoc {
  group_id: number
  settings?: {
    locale?: string
    /** v1 toggle for the external ban databases (lols/CAS). Default true. */
    banDatabase?: boolean
    /** Opt-in reaction-based moderation (off by default). */
    reactionModeration?: boolean
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
    captchaEnabled: doc?.settings?.captcha?.enabled ?? false,
    votingEnabled: doc?.settings?.voting?.enabled ?? true,
    externalBanEnabled: doc?.settings?.banDatabase ?? true,
    reactionModeration: doc?.settings?.reactionModeration ?? false,
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
  reputationScore: number
  reputationStatus: 'trusted' | 'neutral' | 'suspicious' | 'restricted'
  externalBan: { banned: boolean; bannedAt: Date | null; offenses: number } | null
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
): { banned: boolean; bannedAt: Date | null; offenses: number } | null => {
  const lols = externalBan?.lols
  const cas = externalBan?.cas
  const banned = Boolean(lols?.banned) || Boolean(cas?.banned)
  const offenses = Math.max(lols?.offenses ?? 0, cas?.offenses ?? 0)
  const dates = [toDate(lols?.bannedAt), toDate(cas?.bannedAt)].filter((d): d is Date => d !== null)
  const bannedAt = dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null
  return banned || offenses > 0 ? { banned, bannedAt, offenses } : null
}

export const userDocToHistory = (
  doc: UserDoc | null,
  messagesInChat: number,
  nowMs = Date.now()
): UserHistoryView | null => {
  if (!doc) return null
  const stats = doc.globalStats ?? {}
  return {
    firstSeenUnix: stats.firstSeen ? Math.floor(new Date(stats.firstSeen).getTime() / 1000) : null,
    messagesInChat,
    messagesGlobal: stats.totalMessages ?? 0,
    groupsActive: stats.groupsActive ?? 0,
    spamDetections: stats.spamDetections ?? 0,
    reputationScore: doc.reputation?.score ?? 50,
    reputationStatus: doc.reputation?.status ?? 'neutral',
    externalBan: mergeExternalBan(doc.externalBan),
    nameChurn24h: countRecentChanges(doc.nameHistory, nowMs),
    usernameChurn24h: countRecentChanges(doc.usernameHistory, nowMs),
    avatars: null // avatars come from live enrichment, not Mongo
  }
}
