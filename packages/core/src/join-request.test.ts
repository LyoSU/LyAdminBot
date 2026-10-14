import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Signal, UserSnapshot } from './types.js'
import { banGradeReasonOf, joinRequestVerdict } from './join-request.js'
import { extractUserSignals, hasBanGradeAccountVerdict, STALE_EXTERNAL_BAN_DAYS } from './signals/user.js'
import type { AccountScreenChat } from './account-screen-policy.js'

const NOW = Date.parse('2026-10-14T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const makeUser = (overrides: Partial<UserSnapshot> = {}): UserSnapshot => ({
  id: 42,
  username: null,
  displayName: 'Someone',
  languageCode: null,
  flags: { scam: false, fake: false, restricted: false, verified: false, premium: false, bot: false },
  predictedAgeDays: 30,
  predictedAgeBoundsDays: null,
  localAgeDays: null,
  messagesInChat: 0,
  messagesGlobal: 0,
  groupsActive: 0,
  spamDetections: 0,
  reputationStatus: 'neutral',
  externalBan: null,
  unofficialClientRisk: null,
  avatars: null,
  nameChurn24h: 0,
  usernameChurn24h: 0,
  restrictionReasons: [],
  joinedAgoSeconds: null,
  ...overrides
})

const chat: AccountScreenChat = {
  enabled: true, captchaEnabled: true, externalBanEnabled: true, trustedUserIds: []
}
const listed = (daysAgo: number | null) => ({
  banned: true, bannedAt: daysAgo === null ? null : new Date(NOW - daysAgo * DAY), offenses: 1, sources: ['lols' as const]
})
const verdictOf = (user: UserSnapshot, extra: Signal[] = [], c: AccountScreenChat = chat) =>
  joinRequestVerdict({ user, signals: [...extractUserSignals(user, NOW), ...extra], chat: c, now: NOW })
const s = (name: string): Signal => ({ name: name as Signal['name'], evidence: '' })

describe('joinRequestVerdict', () => {
  it('declines what the arrival screen would ban on its record, naming the record', () => {
    expect(verdictOf(makeUser({ externalBan: listed(3) }))).toEqual({ wouldDecide: 'decline', reason: 'external_listing' })
    expect(verdictOf(makeUser({ flags: { ...makeUser().flags, scam: true } })))
      .toEqual({ wouldDecide: 'decline', reason: 'scam_flag' })
    expect(verdictOf(makeUser({ spamDetections: 5 }))).toEqual({ wouldDecide: 'decline', reason: 'prior_detections' })
  })

  it('does not decline on a stale listing — the door does not ban on one either', () => {
    expect(verdictOf(makeUser({ externalBan: listed(STALE_EXTERNAL_BAN_DAYS + 5) })).wouldDecide).not.toBe('decline')
  })

  it('a chat that does not honour lols/CAS refuses a decline resting on a listing alone', () => {
    const v = verdictOf(makeUser({ externalBan: listed(3) }), [], { ...chat, externalBanEnabled: false })
    expect(v).toEqual({ wouldDecide: 'approve', reason: 'decline_refused', blocked: 'external_ban_off' })
  })

  it('but a scam flag is not a third party, and that setting says nothing about it', () => {
    const v = verdictOf(makeUser({ flags: { ...makeUser().flags, scam: true } }), [], { ...chat, externalBanEnabled: false })
    expect(v.wouldDecide).toBe('decline')
  })

  it('looks at a farm-shaped profile and at a profile with a case', () => {
    expect(verdictOf(makeUser(), [s('avatar_recently_set'), s('avatar_shared_with_accounts')]))
      .toEqual({ wouldDecide: 'look', reason: 'farm_shape' })
    expect(verdictOf(makeUser(), [s('nsfw_avatar')])).toEqual({ wouldDecide: 'look', reason: 'profile_case' })
  })

  it('a fresh picture alone is ordinary and approves', () => {
    expect(verdictOf(makeUser(), [s('avatar_recently_set')])).toEqual({ wouldDecide: 'approve', reason: 'clean' })
  })

  it('standing and the chat\'s trust shield a look, never a record', () => {
    const farm = [s('avatar_recently_set'), s('avatar_shared_with_accounts')]
    expect(verdictOf(makeUser({ messagesGlobal: 80 }), farm)).toEqual({ wouldDecide: 'approve', reason: 'established' })
    expect(verdictOf(makeUser(), farm, { ...chat, trustedUserIds: [42] })).toEqual({ wouldDecide: 'approve', reason: 'trusted' })
    expect(verdictOf(makeUser({ messagesGlobal: 80, externalBan: listed(3) })).wouldDecide).toBe('decline')
  })

  it('an unread standing excuses nobody', () => {
    expect(verdictOf(makeUser({ messagesGlobal: null }), [s('nsfw_avatar')]).wouldDecide).toBe('look')
  })

  it('anti-spam off answers approve and says why', () => {
    expect(verdictOf(makeUser({ externalBan: listed(3) }), [], { ...chat, enabled: false }).reason).toBe('antispam_off')
  })

  it('names a reason exactly when the ban-grade bar holds (property)', () => {
    fc.assert(fc.property(
      fc.boolean(), fc.boolean(), fc.option(fc.integer({ min: 0, max: 400 }), { nil: undefined }),
      fc.option(fc.integer({ min: 0, max: 400 }), { nil: null }),
      fc.integer({ min: 0, max: 5 }),
      fc.subarray(['spam', 'porn', 'scam-ish', 'other']),
      (scam, fake, listedDays, bannedDaysAgo, detections, reasons) => {
        const user = makeUser({
          flags: { ...makeUser().flags, scam, fake },
          externalBan: listedDays === undefined ? null : listed(bannedDaysAgo),
          spamDetections: detections,
          restrictionReasons: reasons
        })
        expect(banGradeReasonOf(user, NOW) !== null).toBe(hasBanGradeAccountVerdict(user, NOW))
        expect(verdictOf(user).wouldDecide === 'decline').toBe(hasBanGradeAccountVerdict(user, NOW))
      }
    ))
  })
})
