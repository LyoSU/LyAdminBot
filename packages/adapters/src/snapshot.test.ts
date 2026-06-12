import { describe, expect, it } from 'vitest'
import { User } from '@mtcute/node'
import type { tl } from '@mtcute/node'
import { buildUserSnapshot, type UserHistory } from './snapshot.js'

const NOW = 1_781_000_000

const makeSender = (overrides: Partial<tl.RawUser> = {}): User =>
  new User({
    _: 'user', id: 1_000_000, accessHash: 1n, firstName: 'Іван', lastName: 'Тест',
    username: 'ivan_test', langCode: 'uk',
    ...overrides
  } as tl.RawUser)

const history: UserHistory = {
  firstSeenUnix: NOW - 100 * 86400,
  messagesInChat: 50, messagesGlobal: 300, groupsActive: 3,
  spamDetections: 0, reputationScore: 70, reputationStatus: 'neutral',
  externalBan: null, nameChurn24h: 0, usernameChurn24h: 0,
  avatars: { count: 2, latestSetDaysAgo: 30 }
}

describe('buildUserSnapshot', () => {
  it('maps identity, flags and history', () => {
    const snap = buildUserSnapshot(makeSender({ scam: true, premium: true }), history, NOW)
    expect(snap.id).toBe(1_000_000)
    expect(snap.username).toBe('ivan_test')
    expect(snap.displayName).toBe('Іван Тест')
    expect(snap.flags.scam).toBe(true)
    expect(snap.flags.premium).toBe(true)
    expect(snap.messagesGlobal).toBe(300)
    expect(snap.reputationStatus).toBe('neutral')
  })

  it('derives predicted age from the id and local age from firstSeen', () => {
    const snap = buildUserSnapshot(makeSender(), history, NOW)
    expect(snap.predictedAgeDays).toBeGreaterThan(4000) // 2013 account
    expect(Math.round(snap.localAgeDays ?? 0)).toBe(100)
  })

  it('handles a never-seen user (no history)', () => {
    const snap = buildUserSnapshot(makeSender(), null, NOW)
    expect(snap.localAgeDays).toBeNull()
    expect(snap.messagesInChat).toBe(0)
    expect(snap.reputationStatus).toBe('neutral')
    expect(snap.reputationScore).toBe(50)
    expect(snap.avatars).toBeNull()
  })

  it('dead-zone ids produce null predicted age', () => {
    const snap = buildUserSnapshot(makeSender({ id: 3_000_000_000 }), null, NOW)
    expect(snap.predictedAgeDays).toBeNull()
  })

  it('carries the unofficial-client risk from profile enrichment', () => {
    expect(buildUserSnapshot(makeSender(), null, NOW).unofficialClientRisk).toBeNull()
    expect(
      buildUserSnapshot(makeSender(), null, NOW, { unofficialClientRisk: true }).unofficialClientRisk
    ).toBe(true)
  })
})
