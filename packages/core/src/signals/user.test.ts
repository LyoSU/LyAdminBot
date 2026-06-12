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
    expect(names(makeUser({ externalBan: { banned: true, spamFactor: 0.3 } }))).toContain('external_ban')
    expect(names(makeUser({ externalBan: { banned: false, spamFactor: 0.9 } }))).toContain('external_high_spam_factor')
    expect(names(makeUser({ externalBan: { banned: false, spamFactor: 0.2 } }))).not.toContain('external_ban')
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
