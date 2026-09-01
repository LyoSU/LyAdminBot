import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { UserSnapshot } from '../types.js'
import { contentEvidence, mayRemoveSender } from '../score.js'
import { isTrustSignal } from './registry.js'
import { extractUserSignals, hasHardAccountVerdict
} from './user.js'

const makeUser = (overrides: Partial<UserSnapshot> = {}): UserSnapshot => ({
  id: 42,
  username: 'someone',
  displayName: 'Someone',
  languageCode: 'uk',
  flags: { scam: false, fake: false, restricted: false, verified: false, premium: false, bot: false },
  predictedAgeDays: 800,
  predictedAgeBoundsDays: null,
  localAgeDays: 400,
  messagesInChat: 25,
  messagesGlobal: 120,
  groupsActive: 2,
  spamDetections: 0,
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

describe('extractUserSignals — counters we could not read', () => {
  /**
   * Production 2026-09-01: a sender with 102 messages in one group, findable by
   * Telegram's own search, carried `new_in_chat`. Three separate roads lead to
   * a standing of nothing — a genuine newcomer, a sender whose posts were
   * judged (the debit is charged on the verdict, not on the delete landing),
   * and a counter that never reached us because Mongo was unreachable. Only the
   * first is a fact about the person.
   *
   * `null` is the third road, and it is the one this describe block is for.
   * Same rule as `tenureDays` has kept since 2026-08-20 — losing our record of
   * somebody is not an observation about them — arriving late at the two
   * counters that sit beside it.
   */
  it('accuses nobody of newness when the counters are unknown', () => {
    const unknown = names(makeUser({ messagesInChat: null, messagesGlobal: null }))
    expect(unknown).not.toContain('new_in_chat')
    expect(unknown).not.toContain('new_globally')
  })

  it('does not hand out standing on an unreadable counter either', () => {
    // Abstain means abstain. An outage must not accuse, and it must not excuse:
    // a free `established_user` for every sender is the same failure wearing
    // the other coat, and it is the coat that lets a campaign through.
    const unknown = trust(makeUser({
      messagesInChat: null, messagesGlobal: null, localAgeDays: 400
    }))
    expect(unknown).not.toContain('established_user')
  })

  it('still reads the half it does have', () => {
    // One counter missing is not both missing. A sender we cannot count here
    // but know to be quiet across every chat we watch is still new globally.
    const halfKnown = names(makeUser({ messagesInChat: null, messagesGlobal: 2 }))
    expect(halfKnown).toContain('new_globally')
    expect(halfKnown).not.toContain('new_in_chat')
  })
})

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

  it('says how many lists accuse and how old the listing is — never which lists', () => {
    // The signal that alone carries a 30-day ban used to arrive bare. When an
    // account was banned in three chats for three unremarkable remarks
    // (2026-07-31), nothing recorded how strong the accusation was.
    //
    // It then said too much: it named the databases, in English, inside a card
    // members read (2026-08-30). The count is what a reviewer weighs; the names
    // only tell an operator which service to buy their way off, and they live
    // in the log line instead.
    const now = Date.parse('2026-06-19T12:00:00Z')
    const listed = makeUser({
      externalBan: {
        banned: true, bannedAt: new Date('2026-06-16T12:00:00Z'), offenses: 1, sources: ['cas', 'lols']
      }
    })
    const signal = extractUserSignals(listed, now).find((s) => s.name === 'external_ban')
    expect(signal?.evidence).toBe('external_ban:2:3')
    expect(signal?.evidence).not.toMatch(/cas|lols/i)
  })

  it('an accusation with no date says so rather than inventing one', () => {
    const listed = makeUser({
      externalBan: { banned: true, bannedAt: null, offenses: 1, sources: ['lols'] }
    })
    const signal = extractUserSignals(listed, Date.now()).find((s) => s.name === 'external_ban')
    expect(signal?.evidence).toBe('external_ban:1:?')
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

  it('a member who talks is not asleep, however new our record of them is', () => {
    // Both cannot be true, and for a third of this signal's firings both were.
    // `sleeper_awakened` fired 18863 times in the 14 days to 2026-08-24 and
    // 6202 of those carried `established_user` in the same verdict — the
    // ceiling on tenure is 30 days while volume has none, so a regular of three
    // weeks satisfied each condition separately.
    //
    // Those 6202 led to enforcement 21 times (0.34%); the other 12658 led to it
    // 1910 times (15.09%). The signal was 44x less predictive on the third of
    // its firings where it contradicted itself.
    const chatty = makeUser({
      predictedAgeDays: 1500, localAgeDays: 20, messagesGlobal: 400, messagesInChat: 40
    })
    expect(names(chatty)).toContain('established_user')
    expect(names(chatty)).not.toContain('sleeper_awakened')
  })

  /** Nobody the bot has any reason to vouch for — see `established` below. */
  const stranger = { messagesGlobal: 2, messagesInChat: 1, localAgeDays: 3 }

  it('flags fresh accounts by predicted age', () => {
    expect(names(makeUser({ ...stranger, predictedAgeDays: 5 }))).toContain('fresh_account')
    expect(names(makeUser({ ...stranger, predictedAgeDays: null }))).not.toContain('fresh_account')
  })

  it('reads the YOUNGEST plausible age, not the oldest', () => {
    // REGRESSION, and the sharpest one in the file: this signal had fired zero
    // times in the entire history of the production database when that was
    // checked on 2026-08-24. It used to demand `hi < 30` — "certainly newer
    // than a month" — and since Telegram began allocating ids randomly inside
    // blocks in 2024-02, `hi` is the age of the open block. That was 104 days
    // and rising, so nothing could satisfy it and nothing ever would again.
    //
    // The answerable question is the other bound: could this account have been
    // registered this month? For a block still being handed out the answer is
    // yes by construction, which is exactly the population meant.
    expect(names(makeUser({ ...stranger, predictedAgeDays: 20, predictedAgeBoundsDays: { lo: 0, hi: 104 } })))
      .toContain('fresh_account')
    // A closed block, or the sequential era: the youngest it could be is old.
    expect(names(makeUser({ ...stranger, predictedAgeDays: 300, predictedAgeBoundsDays: { lo: 183, hi: 400 } })))
      .not.toContain('fresh_account')
  })

  it('does not call an account new when we have watched it for longer than that', () => {
    // The id says the account could have been registered this week; our own
    // first-seen row says we were watching it two months ago. An inference does
    // not outrank an observation of the same account — and this is also what
    // bounds the signal if the block table goes stale, since a block left marked
    // open holds `lo` at zero for ever while tenure keeps moving.
    expect(names(makeUser({
      ...stranger, localAgeDays: 60, predictedAgeDays: 20, predictedAgeBoundsDays: { lo: 0, hi: 104 }
    }))).not.toContain('fresh_account')
  })

  it('volume without time does not buy silence on either age signal', () => {
    // `established_user` is earned by fifty messages anywhere with no clock on
    // them, so a farm can have it by the afternoon. The age signals therefore
    // ask for the exempt's bar instead — a week — because an attacker can buy
    // volume and cannot buy tenure.
    const farmed = makeUser({
      messagesGlobal: 400, messagesInChat: 1, localAgeDays: 1, joinedAgoSeconds: 3600,
      predictedAgeDays: 1500, predictedAgeBoundsDays: { lo: 800, hi: 2200 }
    })
    expect(names(farmed)).toContain('established_user')
    expect(names(farmed)).toContain('sleeper_awakened')
  })

  it('does not call an account new when the bot knows the person', () => {
    // The id is an inference; the message counters are an observation of the
    // same account, and where they contradict it the observation wins. A person
    // who registered in June and has posted here since July is both a new
    // account and a known member, and only the second fact is worth acting on.
    const known = { messagesGlobal: 400, messagesInChat: 40, localAgeDays: 30 }
    const signals = names(makeUser({ ...known, predictedAgeDays: 20, predictedAgeBoundsDays: { lo: 0, hi: 104 } }))
    expect(signals).toContain('established_user')
    expect(signals).not.toContain('fresh_account')
  })

  it('holds sleeper_awakened when the account may actually be young', () => {
    const base = { localAgeDays: 3, messagesGlobal: 2, messagesInChat: 1 }
    // point estimate looks like a sleeper, but the optimistic bound is too young
    expect(names(makeUser({ ...base, predictedAgeDays: 700, predictedAgeBoundsDays: { lo: 300, hi: 1100 } })))
      .not.toContain('sleeper_awakened')
    // certainly old: even the youngest plausible age leaves a year-wide gap
    expect(names(makeUser({ ...base, predictedAgeDays: 1500, predictedAgeBoundsDays: { lo: 800, hi: 2200 } })))
      .toContain('sleeper_awakened')
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

  it('a frozen v1 label no longer accuses anybody', () => {
    /**
     * `reputation.status` is v1's, and v1 stopped running. Measured against the
     * store 2026-08-30: 1690 accounts still labelled trusted, 1279 suspicious,
     * 5488 restricted — and the newest `lastCalculated` in the entire
     * collection is 2026-06-12, the day of the v2 restructure. Nothing has
     * recomputed one since, and nothing in v2 can.
     *
     * A frozen computation may keep EXCUSING and must stop ACCUSING, which is
     * the same asymmetry promotion and demotion already keep elsewhere in this
     * codebase. The excuse fails gentle and is revoked the moment anything
     * current condemns the account. The accusation cannot be revised by any
     * path that still exists: it cancelled the established-regular exempt and
     * the ban shield for 6767 accounts on the strength of arithmetic nobody can
     * re-run, and there is no appeal from a system that no longer runs.
     *
     * Costs nothing measurable. `low_reputation` stood on 99 decisions in the
     * fortnight to 2026-08-30 and decided none of them: all 9 that enforced
     * were reached by a stage that had read the message or by `external_ban_new`.
     * v2 writes its own accuser for the same claim, `prior_spam_detections`.
     */
    expect(names(makeUser({ reputationStatus: 'suspicious' }))).not.toContain('low_reputation')
    expect(names(makeUser({ reputationStatus: 'restricted' }))).not.toContain('low_reputation')
    expect(hasHardAccountVerdict(makeUser({ reputationStatus: 'suspicious' }))).toBe(false)
    expect(hasHardAccountVerdict(makeUser({ reputationStatus: 'restricted' }))).toBe(false)
  })

  it('but the same frozen label may still vouch', () => {
    // Trust fails gentle, and `hasHardAccountVerdict` still revokes it the
    // moment anything current says otherwise — see the pairing below.
    expect(names(makeUser({ reputationStatus: 'trusted' }))).toContain('trusted_reputation')
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

  /**
   * The stolen-account shape, and the four ways it must NOT fire.
   *
   * `avatars.count` had been available since the profile layer was written and
   * no signal read it. It is the field that separates "somebody changed their
   * picture" from "somebody deleted a person's photo history and put one of
   * their own up", because Telegram keeps the old photos when you add a new one.
   */
  describe('sole_avatar_replaced', () => {
    const stolen = {
      avatars: { count: 1, latestSetDaysAgo: 2 },
      predictedAgeDays: 1500, localAgeDays: 1, messagesGlobal: 2, messagesInChat: 1
    }

    it('fires on one recent photo over a years-old account', () => {
      expect(names(makeUser(stolen))).toContain('sole_avatar_replaced')
    })

    it('does not fire when there is a photo history', () => {
      expect(names(makeUser({ ...stolen, avatars: { count: 4, latestSetDaysAgo: 2 } })))
        .not.toContain('sole_avatar_replaced')
    })

    it('does not fire on a photo the owner set years ago and never changed', () => {
      expect(names(makeUser({ ...stolen, avatars: { count: 1, latestSetDaysAgo: 900 } })))
        .not.toContain('sole_avatar_replaced')
    })

    /**
     * The case that would otherwise make this fire on half of all newcomers:
     * one fresh photo on a new account is simply what signing up looks like.
     */
    it('does not fire on a genuinely new account', () => {
      expect(names(makeUser({ ...stolen, predictedAgeDays: 5 })))
        .not.toContain('sole_avatar_replaced')
    })

    it('does not fire when the account age is unknown', () => {
      expect(names(makeUser({ ...stolen, predictedAgeDays: null })))
        .not.toContain('sole_avatar_replaced')
    })
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
    expect(trust(makeUser({ reputationStatus: 'trusted' }))).toContain('trusted_reputation')
  })

  /**
   * The one trust signal that consulted no verdict.
   *
   * `established_user` is withheld from an account carrying a hard verdict and
   * has been since 2026-08-24: standing is earned by volume and spent by being
   * caught. This signal weighs more — 2.5 against 1.5 — and is the only one that
   * opens `trusted_clean`, the rule that returns before any heuristic or paid
   * port runs, and it read no verdict at all.
   *
   * Preventive rather than corrective, and the measurement says so plainly: over
   * 228k stored decisions this changes no outcome. What makes it worth having is
   * that the field cannot be downgraded — nothing has written
   * `reputation.status` since 2026-06, so the 1690 accounts holding a frozen
   * "trusted" cannot learn that a ban list picked them up two months later.
   *
   * The admin-vouched half of the signal is added later in the pipeline from
   * `policy.trustedUserIds` and is deliberately left alone: an admin naming
   * somebody outranks a third-party listing about them.
   */
  it('a hard account verdict revokes trusted reputation', () => {
    const listed = makeUser({
      reputationStatus: 'trusted',
      externalBan: { banned: true, bannedAt: null, offenses: 1, sources: ['lols'] }
    })
    expect(trust(listed)).not.toContain('trusted_reputation')
    // The accusing half still fires: revoking trust is not the same as saying
    // nothing about the account.
    expect(names(listed)).toContain('external_ban')

    // Telegram's own flags and our own repeat detections revoke it on the same
    // terms `hasHardAccountVerdict` already states for standing.
    expect(trust(makeUser({
      reputationStatus: 'trusted',
      flags: { scam: true, fake: false, restricted: false, verified: false, premium: false, bot: false }
    }))).not.toContain('trusted_reputation')
    expect(trust(makeUser({ reputationStatus: 'trusted', spamDetections: 2 })))
      .not.toContain('trusted_reputation')
  })

  it('a clean trusted account keeps the signal', () => {
    // The guard must not cost the population it exists to protect. One prior
    // detection is below `PRIOR_DETECTIONS_MIN`, which is the bar every other
    // reader of that counter uses — a single past detection may itself have
    // been the false positive.
    expect(trust(makeUser({ reputationStatus: 'trusted', spamDetections: 1 })))
      .toContain('trusted_reputation')
    expect(trust(makeUser({
      reputationStatus: 'trusted',
      externalBan: { banned: false, bannedAt: null, offenses: 0, sources: [] }
    }))).toContain('trusted_reputation')
  })

  it('trusts established users', () => {
    expect(trust(makeUser({ messagesGlobal: 200 }))).toContain('established_user')
    // Nothing anywhere: too quiet globally AND locally, and no tenure.
    expect(trust(makeUser({ messagesGlobal: 10, messagesInChat: 4, localAgeDays: 1 })))
      .not.toContain('established_user')
  })

  /**
   * The chat's own history counts, on the same terms the established-regular
   * exempt already states: enough messages HERE, and enough time to have said
   * them. Until 2026-08-20 only `messagesGlobal` could earn this signal, so a
   * quiet regular of one chat was a stranger to every stage that reads standing
   * — the trust weight, both ceilings, and the clean rules.
   *
   * The exempt's own note calls the OR deliberate ("local standing here OR a
   * long history across our chats"), and the exempt implements it. What made
   * that half unreachable where it mattered is that the exempt stands down for
   * exactly the messages that can remove a sender, which is the only case in
   * which standing has any work to do.
   */
  it('the chat\'s own history earns standing, not only the network\'s', () => {
    expect(trust(makeUser({ messagesInChat: 14, messagesGlobal: 20, localAgeDays: 400 })))
      .toContain('established_user')
  })

  it('local volume without tenure earns nothing (an afternoon is not standing)', () => {
    // The counters carry no rate condition, so fourteen messages of "ок" in a
    // group the sender controls must not buy the trust weight — the reason the
    // exempt grew a tenure bar on 2026-07-30.
    expect(trust(makeUser({ messagesInChat: 14, messagesGlobal: 20, localAgeDays: 2 })))
      .not.toContain('established_user')
  })

  it('Telegram\'s join date supplies the tenure our own record lost', () => {
    // `localAgeDays` counts from the first time WE saw the account, so it
    // restarts at zero whenever our record does — a v1→v2 migration, the
    // 2026-07-06 quota cleanup, a chat we only just joined. The join date from
    // channels.getParticipant survives all of that, and until now it was read
    // only to accuse (`just_joined`): the bot knew to the second when somebody
    // had joined and used that fact only against them.
    expect(trust(makeUser({
      messagesInChat: 14, messagesGlobal: 20, localAgeDays: 0,
      joinedAgoSeconds: 400 * 86_400
    }))).toContain('established_user')
  })

  it('REGRESSION: standing does not require a reputation score nothing writes', () => {
    // v2 never writes reputation.score, so it is always the default 50. The
    // old `>= 60` condition therefore made this signal — and every clean rule
    // and trust weight built on it — unreachable for every real user.
    expect(trust(makeUser({ messagesGlobal: 200 })))
      .toContain('established_user')
  })

  it('a hard verdict denies standing however much the account posted', () => {
    const veteran = { messagesGlobal: 5000, messagesInChat: 900 }
    const condemned: Partial<UserSnapshot>[] = [
      { flags: { scam: true, fake: false, restricted: false, verified: false, premium: false, bot: false } },
      { flags: { scam: false, fake: true, restricted: false, verified: false, premium: false, bot: false } },
      { externalBan: { banned: true, bannedAt: null, offenses: 1, sources: ['lols'] } },
      { restrictionReasons: ['spam'] },
      // Ours, and it joined the list on 2026-08-24 when the two definitions of
      // "hard verdict" were merged. The pipeline had always denied the exempt
      // on it while this signal did not, so 1969 verdicts in a fortnight
      // carried `established_user` next to `prior_spam_detections` — standing
      // withheld by one stage and granted by the next. Two, never one: a single
      // detection may have been the mistake.
      { spamDetections: 2 }
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
    // Below the established bar in BOTH scopes, so the badge is the only thing
    // that could possibly earn leniency here.
    const premium = makeUser({
      messagesGlobal: 3,
      messagesInChat: 2,
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
    //
    // Called plainly rather than through `expect(...).not.toThrow()`: a throw
    // fails the property either way, and fast-check then reports the shrunk
    // counterexample, which is the more useful message. The wrapper captured a
    // stack per run, a hundred of them, for no gain.
    //
    // This test times out intermittently under the full suite (2026-08-22), and
    // the wrapper is NOT the whole story: the property itself measures ~15ms per
    // hundred runs standalone, `extractUserSignals` ~2µs per case over 5000
    // arbitrary binary strings, and the file alone runs in 300ms. Whatever
    // pushes it past 5s is contention, not this code — the same report showed a
    // second property test at 7s. Left as a known flake rather than papered over
    // with a longer timeout, because the cause is not yet understood.
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (displayName) => {
      extractUserSignals(makeUser({ displayName }))
      return true
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
