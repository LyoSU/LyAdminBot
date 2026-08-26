import { describe, expect, it } from 'vitest'
import { User } from '@mtcute/node'
import type { tl } from '@mtcute/node'
import { buildUserSnapshot, withLiveFacts, type UserHistory } from './snapshot.js'

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

  it('carries restriction_reason codes from the user constructor', () => {
    expect(buildUserSnapshot(makeSender(), null, NOW).restrictionReasons).toEqual([])
    const restricted = makeSender({
      restricted: true,
      restrictionReason: [{ _: 'restrictionReason', platform: 'all', reason: 'spam', text: 'spam' }]
    })
    expect(buildUserSnapshot(restricted, null, NOW).restrictionReasons).toEqual(['spam'])
  })

  it('carries the chat join recency from profile enrichment', () => {
    expect(buildUserSnapshot(makeSender(), null, NOW).joinedAgoSeconds).toBeNull()
    expect(
      buildUserSnapshot(makeSender(), null, NOW, { unofficialClientRisk: null, joinedAgoSeconds: 12 }).joinedAgoSeconds
    ).toBe(12)
  })
})


/**
 * The three callers that enrich a stored history with something they just
 * fetched — fresh avatars, a live lols/CAS answer — all guarded the enrichment
 * with `history === null ? null : {...}`, so the live answer was computed and
 * then dropped for every account we had no row for. That is precisely the
 * account arriving for the first time: 634 of the 1208 external-ban bans in the
 * week to 2026-08-26 were accounts unknown to us until the message we banned
 * them for.
 */
describe('withLiveFacts', () => {
  const banned = {
    banned: true, bannedAt: new Date('2026-08-01'), offenses: 2, sources: ['cas']
  } as UserHistory['externalBan']

  it('REGRESSION: a live ban answer survives having no stored history', () => {
    const snap = buildUserSnapshot(makeSender(), withLiveFacts(null, {
      avatars: { count: 1, latestSetDaysAgo: 0 }, externalBan: banned
    }), NOW)
    expect(snap.externalBan?.banned).toBe(true)
    expect(snap.avatars?.count).toBe(1)
  })

  it('leaves the rest of a missing history exactly where the snapshot would', () => {
    const enriched = buildUserSnapshot(makeSender(), withLiveFacts(null, {
      avatars: null, externalBan: null
    }), NOW)
    const bare = buildUserSnapshot(makeSender(), null, NOW)
    expect(enriched).toEqual(bare)
  })

  it('keeps what the stored history says and overwrites only the live fields', () => {
    const snap = buildUserSnapshot(makeSender(), withLiveFacts(history, {
      avatars: { count: 9, latestSetDaysAgo: 1 }, externalBan: banned
    }), NOW)
    expect(snap.messagesGlobal).toBe(300)
    expect(snap.avatars?.count).toBe(9)
    expect(snap.externalBan?.banned).toBe(true)
  })

  it('an explicit null ban is an answer, not a gap to fall through', () => {
    // A chat with `externalBanEnabled` off passes null on purpose; falling back
    // to the stored value would re-enable exactly what the chat switched off.
    const snap = buildUserSnapshot(makeSender(), withLiveFacts(
      { ...history, externalBan: banned },
      { avatars: null, externalBan: null }
    ), NOW)
    expect(snap.externalBan).toBeNull()
  })
})
