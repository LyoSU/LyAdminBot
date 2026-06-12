/**
 * UserSnapshot builder: merges what Telegram tells us about the sender
 * (free with the update) with what we remember about them (data layer).
 */
import type { User } from '@mtcute/node'
import type { UserSnapshot } from '@lyadmin/core'
import { predictAccountAgeDays } from './account-age.js'

/** Persisted history the data layer provides (all fields best-effort). */
export interface UserHistory {
  firstSeenUnix: number | null
  messagesInChat: number
  messagesGlobal: number
  groupsActive: number
  spamDetections: number
  reputationScore: number
  reputationStatus: UserSnapshot['reputationStatus']
  externalBan: { banned: boolean; spamFactor: number } | null
  nameChurn24h: number
  usernameChurn24h: number
  avatars: { count: number; latestSetDaysAgo: number | null } | null
}

/** Enrichment-sourced profile facts (users.getFullUser). */
export interface UserProfileFacts {
  unofficialClientRisk: boolean | null
}

export const buildUserSnapshot = (
  sender: User,
  history: UserHistory | null,
  nowUnix = Math.floor(Date.now() / 1000),
  profile: UserProfileFacts | null = null
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
  predictedAgeDays: predictAccountAgeDays(sender.id, nowUnix),
  localAgeDays: history?.firstSeenUnix != null
    ? Math.max(0, (nowUnix - history.firstSeenUnix) / 86400)
    : null,
  messagesInChat: history?.messagesInChat ?? 0,
  messagesGlobal: history?.messagesGlobal ?? 0,
  groupsActive: history?.groupsActive ?? 0,
  spamDetections: history?.spamDetections ?? 0,
  reputationScore: history?.reputationScore ?? 50,
  reputationStatus: history?.reputationStatus ?? 'neutral',
  externalBan: history?.externalBan ?? null,
  unofficialClientRisk: profile?.unofficialClientRisk ?? null,
  avatars: history?.avatars ?? null,
  nameChurn24h: history?.nameChurn24h ?? 0,
  usernameChurn24h: history?.usernameChurn24h ?? 0
})
