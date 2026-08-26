/**
 * UserSnapshot builder: merges what Telegram tells us about the sender
 * (free with the update) with what we remember about them (data layer).
 */
import type { Chat, User } from '@mtcute/node'
import type { ExternalBanFacts, UserSnapshot } from '@lyadmin/core'
import { predictAccountAgeBoundsDays, predictAccountAgeDays } from './account-age.js'

/** Persisted history the data layer provides (all fields best-effort). */
export interface UserHistory {
  firstSeenUnix: number | null
  messagesInChat: number
  messagesGlobal: number
  groupsActive: number
  spamDetections: number
  reputationScore: number
  reputationStatus: UserSnapshot['reputationStatus']
  externalBan: ExternalBanFacts | null
  nameChurn24h: number
  usernameChurn24h: number
  avatars: { count: number; latestSetDaysAgo: number | null } | null
}

/** Enrichment-sourced profile facts (users.getFullUser + getParticipant). */
export interface UserProfileFacts {
  unofficialClientRisk: boolean | null
  /** Seconds since the user joined this chat (channels.getParticipant.date). */
  joinedAgoSeconds?: number | null
  joinedDuringSurge?: boolean
}

/**
 * What we know about an account before anybody has told us anything.
 *
 * One place, because there were two: `buildUserSnapshot` applied these defaults
 * through `??` on every field, and any caller wanting to fold in a fact it had
 * just fetched had to reproduce them or give up. Every caller gave up — see
 * `withLiveFacts`.
 */
const EMPTY_HISTORY: UserHistory = {
  firstSeenUnix: null,
  messagesInChat: 0,
  messagesGlobal: 0,
  groupsActive: 0,
  spamDetections: 0,
  reputationScore: 50,
  reputationStatus: 'neutral',
  externalBan: null,
  nameChurn24h: 0,
  usernameChurn24h: 0,
  avatars: null
}

/**
 * A stored history with what we just learned live folded into it.
 *
 * The three callers that enrich a history — the message pipeline, `/report`'s
 * account screen and the `/check` card — each wrote
 * `history === null ? null : { ...history, avatars, externalBan }`. The guard
 * looks defensive and is the opposite: `buildUserSnapshot` has always accepted
 * a null history perfectly well, so the ternary did nothing except throw away
 * the live answer for accounts we had no row for. Those are exactly the
 * accounts arriving for the first time — 634 of the 1208 external-ban bans in
 * the week to 2026-08-26 were accounts unknown to us until the message we
 * banned them for, and on `/check` an admin was told "not listed" about an
 * account the lookup a line earlier had found listed.
 *
 * `live` overwrites rather than fills a gap. A chat with `externalBanEnabled`
 * off passes null deliberately, and falling back to the stored value there
 * would hand back exactly what the chat switched off.
 */
export const withLiveFacts = (
  history: UserHistory | null,
  live: Pick<UserHistory, 'avatars' | 'externalBan'>
): UserHistory => ({ ...EMPTY_HISTORY, ...(history ?? {}), ...live })

export const buildUserSnapshot = (
  sender: User,
  history: UserHistory | null,
  nowUnix = Math.floor(Date.now() / 1000),
  profile: UserProfileFacts | null = null
): UserSnapshot => snapshotOf(sender, history ?? EMPTY_HISTORY, nowUnix, profile)

const snapshotOf = (
  sender: User,
  history: UserHistory,
  nowUnix: number,
  profile: UserProfileFacts | null
): UserSnapshot => ({
  id: sender.id,
  username: sender.username,
  displayName: sender.displayName,
  languageCode: sender.language,
  flags: {
    scam: sender.isScam,
    fake: sender.isFake,
    restricted: sender.isRestricted,
    verified: sender.isVerified,
    premium: sender.isPremium,
    bot: sender.isBot
  },
  // restriction_reason ships free with the user constructor; keep the reason
  // codes (e.g. 'spam') — empty for unrestricted users or when absent.
  restrictionReasons: sender.restrictionReason?.map((r) => r.reason) ?? [],
  joinedAgoSeconds: profile?.joinedAgoSeconds ?? null,
  joinedDuringSurge: profile?.joinedDuringSurge ?? false,
  predictedAgeDays: predictAccountAgeDays(sender.id, nowUnix),
  predictedAgeBoundsDays: predictAccountAgeBoundsDays(sender.id, nowUnix),
  localAgeDays: history.firstSeenUnix != null
    ? Math.max(0, (nowUnix - history.firstSeenUnix) / 86400)
    : null,
  messagesInChat: history.messagesInChat,
  messagesGlobal: history.messagesGlobal,
  groupsActive: history.groupsActive,
  spamDetections: history.spamDetections,
  reputationScore: history.reputationScore,
  reputationStatus: history.reputationStatus,
  externalBan: history.externalBan,
  unofficialClientRisk: profile?.unofficialClientRisk ?? null,
  avatars: history.avatars,
  nameChurn24h: history.nameChurn24h,
  usernameChurn24h: history.usernameChurn24h
})

/**
 * Snapshot for a message sent *as a channel* — Telegram's "send as", which any
 * member who owns a channel can use and which the pipeline used to skip
 * entirely (the intake accepted `User` senders only). Channel-promo drops are
 * one of the spam classes v2 exists to catch, so refusing to look at the one
 * delivery method that advertises a channel by construction was a hole.
 *
 * Everything account-shaped is deliberately null/zero: a channel has no
 * registration date to predict, no bio we read, no avatar we screen and no
 * client to be flagged for. The verdict therefore rests on the message — which
 * is the right basis for it anyway. Telegram's own scam/fake flags DO exist for
 * channels and are the one account-level fact worth carrying over.
 */
export const buildChannelSnapshot = (
  sender: Chat,
  history: UserHistory | null,
  nowUnix = Math.floor(Date.now() / 1000)
): UserSnapshot => ({
  id: sender.id,
  username: sender.username,
  displayName: sender.displayName,
  languageCode: null,
  flags: {
    scam: sender.isScam,
    fake: sender.isFake,
    restricted: sender.isRestricted,
    verified: sender.isVerified,
    premium: false,
    bot: false
  },
  restrictionReasons: [],
  joinedAgoSeconds: null,
  joinedDuringSurge: false,
  // Channel ids come from a different namespace than user ids: feeding one to
  // the user-id → registration-date table would invent an age.
  predictedAgeDays: null,
  predictedAgeBoundsDays: null,
  localAgeDays: history?.firstSeenUnix != null
    ? Math.max(0, (nowUnix - history.firstSeenUnix) / 86400)
    : null,
  messagesInChat: history?.messagesInChat ?? 0,
  messagesGlobal: history?.messagesGlobal ?? 0,
  groupsActive: history?.groupsActive ?? 0,
  spamDetections: history?.spamDetections ?? 0,
  reputationScore: history?.reputationScore ?? 50,
  reputationStatus: history?.reputationStatus ?? 'neutral',
  externalBan: null,
  unofficialClientRisk: null,
  avatars: null,
  nameChurn24h: 0,
  usernameChurn24h: 0
})
