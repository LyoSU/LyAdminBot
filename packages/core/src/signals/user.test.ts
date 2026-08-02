import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { UserSnapshot } from '../types.js'
import { contentEvidence, mayRemoveSender } from '../score.js'
import { isTrustSignal } from './registry.js'
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
  extractUserSignals(u).filter((s) => isTrustSignal(s.name)).map((s) => s.name)

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
    expect(names(makeUser({ externalBan: { banned: true, bannedAt: null, offenses: 1, sources: ['lols'] } }))).toContain('external_ban')
    expect(names(makeUser({ externalBan: { banned: false, bannedAt: null, offenses: 0, sources: [] } }))).not.toContain('external_ban')
  })

  it('says who did the accusing and how old the listing is', () => {
    // The signal that alone carries a 30-day ban used to arrive bare. When an
    // account was banned in three chats for three unremarkable remarks
    // (2026-07-31), nothing recorded which database had listed it — and the two
    // are not interchangeable.
    const now = Date.parse('2026-06-19T12:00:00Z')
    const listed = makeUser({
      externalBan: {
        banned: true, bannedAt: new Date('2026-06-16T12:00:00Z'), offenses: 1, sources: ['cas']
      }
    })
    const signal = extractUserSignals(listed, now).find((s) => s.name === 'external_ban')
    expect(signal?.evidence).toContain('cas')
    expect(signal?.evidence).toContain('3d')
  })

  it('an accusation with no date says so rather than inventing one', () => {
    const listed = makeUser({
      externalBan: { banned: true, bannedAt: null, offenses: 1, sources: ['lols'] }
    })
    const signal = extractUserSignals(listed, Date.now()).find((s) => s.name === 'external_ban')
    expect(signal?.evidence).toContain('lols')
    expect(signal?.evidence).not.toMatch(/NaN|Invalid|undefined/)
  })

  it('flags a repeat offender (CAS offenses >= 2), not a single listing', () => {
    expect(names(makeUser({ externalBan: { banned: true, bannedAt: null, offenses: 3, sources: ['lols'] } }))).toContain('external_repeat_offender')
    expect(names(makeUser({ externalBan: { banned: true, bannedAt: null, offenses: 1, sources: ['lols'] } }))).not.toContain('external_repeat_offender')
  })

  it('flags a freshly-added external ban (<48h), not an old one', () => {
    const now = Date.parse('2026-06-19T12:00:00Z')
    const fresh = makeUser({ externalBan: { banned: true, bannedAt: new Date('2026-06-19T09:00:00Z'), offenses: 1, sources: ['lols'] } })
    const old = makeUser({ externalBan: { banned: true, bannedAt: new Date('2026-06-01T00:00:00Z'), offenses: 1, sources: ['lols'] } })
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

  it('treats joining during a surge as account shape, never message evidence', () => {
    const signals = extractUserSignals(makeUser({ joinedDuringSurge: true }))
    expect(signals).toContainEqual({ name: 'joined_during_surge' })
    expect(contentEvidence(signals)).toEqual({ strongest: 0, total: 0 })
    expect(mayRemoveSender(signals)).toBe(false)
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

  it('one prior detection is an accusation, two are a pattern', () => {
    // Nothing pinned this before 2026-08-01 because nothing wrote the counter,
    // so the signal fired at one detection and never on anything v2 had caught.
    // Firing at one means a false positive makes the next evaluation of the
    // same person harsher — the FP compounds. The bar matches the one the
    // established-regular exempt uses.
    expect(names(makeUser({ spamDetections: 1 }))).not.toContain('prior_spam_detections')
    expect(names(makeUser({ spamDetections: 2 }))).toContain('prior_spam_detections')
  })

  it('flags low reputation', () => {
    expect(names(makeUser({ reputationStatus: 'suspicious' }))).toContain('low_reputation')
    expect(names(makeUser({ reputationStatus: 'restricted' }))).toContain('low_reputation')
  })

  it('flags promo carried in the display name', () => {
    expect(names(makeUser({ displayName: 'Заробіток t.me/+abcdef' }))).toContain('promo_in_name')
    expect(names(makeUser({ displayName: 'Крипта bit.ly/xyz' }))).toContain('promo_in_name')
    expect(names(makeUser({ displayName: 'Пиши @spamchannel' }))).toContain('promo_in_name')
    expect(names(makeUser({ displayName: 'Магазин shop.example/sale' }))).toContain('promo_in_name')
  })

  it('does not mistake an ordinary name for promo', () => {
    for (const displayName of [
      'Someone', 'Іван Петренко', 'Anna 🌸', 'Dr. O\'Brien', 'вова', 'x_y',
      'Марія | Київ', 'user.name', 'Ann-Marie', '田中太郎'
    ]) {
      expect(names(makeUser({ displayName })), displayName).not.toContain('promo_in_name')
    }
  })

  it('duplicating your OWN handle into your name is not promo', () => {
    expect(names(makeUser({ username: 'someone', displayName: 'Someone @someone' })))
      .not.toContain('promo_in_name')
    // …but advertising a DIFFERENT handle is.
    expect(names(makeUser({ username: 'someone', displayName: 'Someone @otherchan' })))
      .toContain('promo_in_name')
  })

  it('carries the offending fragment as evidence', () => {
    const signal = extractUserSignals(makeUser({ displayName: 'Робота t.me/+jobs' }))
      .find((s) => s.name === 'promo_in_name')
    expect(signal?.evidence).toContain('t.me/+jobs')
  })

  it('flags invisible characters used to disguise a display name', () => {
    expect(names(makeUser({ displayName: 'Ад​мін' }))).toContain('invisible_in_name')
    expect(names(makeUser({ displayName: 'name‮gnp.exe' }))).toContain('invisible_in_name')
    expect(names(makeUser({ displayName: 'Someone' }))).not.toContain('invisible_in_name')
  })

  it('does not flag emoji sequences or bidirectional names as invisible-char evasion', () => {
    // ZWJ family emoji and the LTR/RTL *marks* are legitimate; only padding
    // and the bidi overrides are evasion.
    for (const displayName of ['👨‍👩‍👧', 'עברית‏שלום', 'ناصر‎']) {
      expect(names(makeUser({ displayName })), displayName).not.toContain('invisible_in_name')
    }
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

  it('REGRESSION: standing does not require a reputation score nothing writes', () => {
    // v2 never writes reputation.score, so it is always the default 50. The
    // old `>= 60` condition therefore made this signal — and every clean rule
    // and trust weight built on it — unreachable for every real user.
    expect(trust(makeUser({ messagesGlobal: 200, reputationScore: 50 })))
      .toContain('established_user')
  })

  it('a hard verdict denies standing however much the account posted', () => {
    const veteran = { messagesGlobal: 5000, messagesInChat: 900 }
    const condemned: Partial<UserSnapshot>[] = [
      { flags: { scam: true, fake: false, restricted: false, verified: false, premium: false, bot: false } },
      { flags: { scam: false, fake: true, restricted: false, verified: false, premium: false, bot: false } },
      { externalBan: { banned: true, bannedAt: null, offenses: 1, sources: ['lols'] } },
      { reputationStatus: 'suspicious' },
      { reputationStatus: 'restricted' },
      { restrictionReasons: ['spam'] }
    ]
    for (const verdict of condemned) {
      expect(trust(makeUser({ ...veteran, ...verdict })), JSON.stringify(verdict))
        .not.toContain('established_user')
    }
    // The control: the same veteran without any verdict does earn it.
    expect(trust(makeUser(veteran))).toContain('established_user')
  })

  it('an unofficial client does NOT deny standing (it is a heuristic, not a verdict)', () => {
    expect(trust(makeUser({ messagesGlobal: 5000, unofficialClientRisk: true })))
      .toContain('established_user')
  })

  it('premium buys no trust (spammers buy premium)', () => {
    // The old form asserted no signal is *named* `premium`, which the catalogue
    // now settles at compile time — there is no such name to raise. What still
    // needs testing is the decision itself: a premium badge and nothing else
    // must not earn the account any leniency.
    // messagesGlobal below the established bar, so the badge is the only thing
    // that could possibly earn leniency here.
    const premium = makeUser({
      messagesGlobal: 3,
      flags: { scam: false, fake: false, restricted: false, verified: false, premium: true, bot: false }
    })
    expect(extractUserSignals(premium).filter((s) => isTrustSignal(s.name))).toEqual([])
  })

  it('never crashes on a snapshot full of nulls', () => {
    const bare = makeUser({
      username: null, languageCode: null, predictedAgeDays: null,
      localAgeDays: null, externalBan: null, avatars: null
    })
    expect(() => extractUserSignals(bare)).not.toThrow()
  })
})

describe('extractUserSignals — robustness', () => {
  // Display names are attacker-controlled and arrive as arbitrary UTF-16,
  // lone surrogates included. Extraction must degrade, never throw: a crash
  // here takes down moderation for the whole chat.
  it('property: survives any display name and username', () => {
    fc.assert(fc.property(fc.string(), fc.option(fc.string(), { nil: null }), (displayName, username) => {
      const signals = extractUserSignals(makeUser({ displayName, username }))
      return Array.isArray(signals) && signals.every((s) => typeof s.name === 'string')
    }))
  })

  it('property: never throws on arbitrary unicode, lone surrogates included', () => {
    // `unit: 'binary'` generates raw UTF-16 code units, so unpaired surrogates
    // reach the regexes — the shape that has bitten this codebase before.
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (displayName) => {
      expect(() => extractUserSignals(makeUser({ displayName }))).not.toThrow()
    }))
  })

  it('property: extraction is a pure function of the snapshot', () => {
    fc.assert(fc.property(fc.string(), fc.integer({ min: 0, max: 10_000 }), (displayName, messagesGlobal) => {
      const user = makeUser({ displayName, messagesGlobal })
      const now = 1_780_000_000_000
      expect(extractUserSignals(user, now)).toEqual(extractUserSignals(user, now))
    }))
  })

  it('the global regexes are not left stateful between calls', () => {
    // URL_TOKEN_REGEX and HANDLE_IN_NAME_REGEX are /g. If a caller ever used
    // .test() on them, lastIndex would leak and every other call would miss.
    const promo = makeUser({ displayName: 'Робота t.me/+jobs' })
    for (let i = 0; i < 5; i += 1) {
      expect(names(promo), `call ${i}`).toContain('promo_in_name')
    }
  })
})
