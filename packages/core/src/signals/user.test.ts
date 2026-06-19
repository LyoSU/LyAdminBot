import { describe, expect, it } from 'vitest'
import type { UserSnapshot } from '../types.js'
import { extractUserSignals } from './user.js'

const makeUser = (overrides: Partial<UserSnapshot> = {}): UserSnapshot => ({
  id: 42,
  username: 'someone',
  displayName: 'Someone',
  languageCode: 'uk',
  flags: { scam: false, fake: false, restricted: false, verified: false, premium: false, bot: false },
  predictedAgeDays: 800,
  localAgeDays: 400,
  messagesInChat: 25,
  messagesGlobal: 120,
  groupsActive: 2,
  spamDetections: 0,
  reputationScore: 65,
  reputationStatus: 'neutral',
  externalBan: null,
  unofficialClientRisk: null,
  avatars: { count: 2, latestSetDaysAgo: 200 },
  nameChurn24h: 0,
  usernameChurn24h: 0,
  restrictionReasons: [],
  joinedAgoSeconds: null,
  ...overrides
})

const names = (u: UserSnapshot): string[] => extractUserSignals(u).map((s) => s.name)
const trust = (u: UserSnapshot): string[] =>
  extractUserSignals(u).filter((s) => s.negative).map((s) => s.name)

describe('extractUserSignals — suspicious', () => {
  it('flags Telegram scam/fake flags', () => {
    expect(names(makeUser({ flags: { scam: true, fake: false, restricted: false, verified: false, premium: false, bot: false } }))).toContain('scam_flag')
    expect(names(makeUser({ flags: { scam: false, fake: true, restricted: false, verified: false, premium: false, bot: false } }))).toContain('fake_flag')
  })

  it('flags server-detected unofficial-client risk (strongest account marker)', () => {
    expect(names(makeUser({ unofficialClientRisk: true }))).toContain('unofficial_client_risk')
    expect(names(makeUser({ unofficialClientRisk: false }))).not.toContain('unofficial_client_risk')
    expect(names(makeUser({ unofficialClientRisk: null }))).not.toContain('unofficial_client_risk')
  })

  it('flags external ban databases', () => {
    expect(names(makeUser({ externalBan: { banned: true, bannedAt: null, offenses: 1 } }))).toContain('external_ban')
    expect(names(makeUser({ externalBan: { banned: false, bannedAt: null, offenses: 0 } }))).not.toContain('external_ban')
  })

  it('flags a repeat offender (CAS offenses >= 2), not a single listing', () => {
    expect(names(makeUser({ externalBan: { banned: true, bannedAt: null, offenses: 3 } }))).toContain('external_repeat_offender')
    expect(names(makeUser({ externalBan: { banned: true, bannedAt: null, offenses: 1 } }))).not.toContain('external_repeat_offender')
  })

  it('flags a freshly-added external ban (<48h), not an old one', () => {
    const now = Date.parse('2026-06-19T12:00:00Z')
    const fresh = makeUser({ externalBan: { banned: true, bannedAt: new Date('2026-06-19T09:00:00Z'), offenses: 1 } })
    const old = makeUser({ externalBan: { banned: true, bannedAt: new Date('2026-06-01T00:00:00Z'), offenses: 1 } })
    expect(extractUserSignals(fresh, now).map((s) => s.name)).toContain('fresh_external_ban')
    expect(extractUserSignals(old, now).map((s) => s.name)).not.toContain('fresh_external_ban')
  })

  it('flags a spreader: many shared chats while globally new', () => {
    expect(names(makeUser({ groupsActive: 8, messagesGlobal: 2 }))).toContain('many_shared_chats')
    // an established user in many shared chats is NOT a spreader
    expect(names(makeUser({ groupsActive: 8, messagesGlobal: 500 }))).not.toContain('many_shared_chats')
  })

  it('flags a Telegram spam/scam restriction reason, beyond the bare flag', () => {
    expect(names(makeUser({ restrictionReasons: ['spam'] }))).toContain('restricted_for_spam')
    expect(names(makeUser({ restrictionReasons: ['geoirrelevant'] }))).not.toContain('restricted_for_spam')
    expect(names(makeUser({ restrictionReasons: [] }))).not.toContain('restricted_for_spam')
  })

  it('flags a user who joined moments before posting', () => {
    expect(names(makeUser({ joinedAgoSeconds: 15 }))).toContain('just_joined')
    expect(names(makeUser({ joinedAgoSeconds: 3600 }))).not.toContain('just_joined')
    expect(names(makeUser({ joinedAgoSeconds: null }))).not.toContain('just_joined')
  })

  it('flags sleeper-awakened accounts (old account, fresh local activity)', () => {
    const sleeper = makeUser({ predictedAgeDays: 1500, localAgeDays: 3, messagesGlobal: 2, messagesInChat: 1 })
    expect(names(sleeper)).toContain('sleeper_awakened')
    // long-time local member is not a sleeper even if account is old
    expect(names(makeUser({ predictedAgeDays: 1500, localAgeDays: 400 }))).not.toContain('sleeper_awakened')
  })

  it('flags fresh accounts by predicted age', () => {
    expect(names(makeUser({ predictedAgeDays: 5 }))).toContain('fresh_account')
    expect(names(makeUser({ predictedAgeDays: null }))).not.toContain('fresh_account')
  })

  it('flags identity churn within 24h', () => {
    expect(names(makeUser({ nameChurn24h: 3 }))).toContain('identity_churn_24h')
    expect(names(makeUser({ usernameChurn24h: 4 }))).toContain('identity_churn_24h')
    expect(names(makeUser({ nameChurn24h: 1 }))).not.toContain('identity_churn_24h')
  })

  it('flags newcomers locally and globally', () => {
    expect(names(makeUser({ messagesInChat: 1 }))).toContain('new_in_chat')
    expect(names(makeUser({ messagesGlobal: 2, messagesInChat: 1 }))).toContain('new_globally')
  })

  it('flags prior spam detections and low reputation', () => {
    expect(names(makeUser({ spamDetections: 2 }))).toContain('prior_spam_detections')
    expect(names(makeUser({ reputationStatus: 'suspicious' }))).toContain('low_reputation')
    expect(names(makeUser({ reputationStatus: 'restricted' }))).toContain('low_reputation')
  })

  it('flags a freshly set avatar only for locally-new users', () => {
    const fresh = makeUser({ avatars: { count: 1, latestSetDaysAgo: 2 }, localAgeDays: 1, messagesGlobal: 3, messagesInChat: 1 })
    expect(names(fresh)).toContain('avatar_recently_set')
    // established user changing avatar is normal life
    expect(names(makeUser({ avatars: { count: 5, latestSetDaysAgo: 2 } }))).not.toContain('avatar_recently_set')
  })
})

describe('extractUserSignals — trust (negative)', () => {
  it('trusts verified accounts and trusted reputation', () => {
    expect(trust(makeUser({ flags: { scam: false, fake: false, restricted: false, verified: true, premium: false, bot: false } }))).toContain('verified_account')
    expect(trust(makeUser({ reputationStatus: 'trusted', reputationScore: 85 }))).toContain('trusted_reputation')
  })

  it('trusts established users', () => {
    expect(trust(makeUser({ messagesGlobal: 200, reputationScore: 70 }))).toContain('established_user')
    expect(trust(makeUser({ messagesGlobal: 10 }))).not.toContain('established_user')
  })

  it('premium is NOT a trust signal (spammers buy premium)', () => {
    const premium = makeUser({ flags: { scam: false, fake: false, restricted: false, verified: false, premium: true, bot: false } })
    expect(extractUserSignals(premium).every((s) => s.name !== 'premium')).toBe(true)
  })

  it('never crashes on a snapshot full of nulls', () => {
    const bare = makeUser({
      username: null, languageCode: null, predictedAgeDays: null,
      localAgeDays: null, externalBan: null, avatars: null
    })
    expect(() => extractUserSignals(bare)).not.toThrow()
  })
})
