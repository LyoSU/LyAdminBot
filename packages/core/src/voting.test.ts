import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  tallyVotes, voterRoster, voteEligibility, voteMayRecordDetection, VOTE_TENURE_ALONE_DAYS,
  expiryOutcome, UNOPPOSED_EXPIRY_MIN_SPAM,
  type VoteBallot, type VoterStanding
} from './voting.js'

const b = (userId: number, choice: 'spam' | 'ham', isAdmin = false): VoteBallot =>
  ({ userId, choice, isAdmin })

describe('tallyVotes', () => {
  it('stays pending below the threshold', () => {
    expect(tallyVotes([b(1, 'spam'), b(2, 'spam')]).outcome).toBe('pending')
    expect(tallyVotes([]).outcome).toBe('pending')
  })

  it('resolves spam at net +3 and ham at net -3', () => {
    expect(tallyVotes([b(1, 'spam'), b(2, 'spam'), b(3, 'spam')]).outcome).toBe('spam')
    expect(tallyVotes([b(1, 'ham'), b(2, 'ham'), b(3, 'ham')]).outcome).toBe('ham')
    expect(tallyVotes([b(1, 'spam'), b(2, 'spam'), b(3, 'spam'), b(4, 'ham')]).outcome).toBe('pending')
  })

  it('counts only the latest ballot per user (re-votes allowed)', () => {
    const tally = tallyVotes([b(1, 'spam'), b(2, 'spam'), b(1, 'ham')])
    expect(tally.spam).toBe(1)
    expect(tally.ham).toBe(1)
    expect(tally.outcome).toBe('pending')
  })

  it('an admin ballot decides immediately, latest admin wins', () => {
    expect(tallyVotes([b(1, 'ham'), b(9, 'spam', true)]).outcome).toBe('spam')
    expect(tallyVotes([b(9, 'spam', true), b(8, 'ham', true)]).outcome).toBe('ham')
  })

  it('says whether the quorum agreed or one admin decided', () => {
    // The log used to call every community-path resolution "community", so a
    // 2:0 spam outcome — arithmetically impossible at a net-3 threshold, and
    // therefore always an admin ballot — was filed as the chat agreeing.
    expect(tallyVotes([b(1, 'spam'), b(2, 'spam'), b(3, 'spam')]).decidedBy).toBe('quorum')
    expect(tallyVotes([b(1, 'spam'), b(9, 'spam', true)]).decidedBy).toBe('admin')
  })

  it('an unresolved vote was decided by nobody', () => {
    expect(tallyVotes([b(1, 'spam')]).decidedBy).toBeNull()
    expect(tallyVotes([]).decidedBy).toBeNull()
  })

  it('an admin agreeing with a quorum still counts as the admin deciding', () => {
    // They resolved it the moment they tapped; the others were already there.
    const tally = tallyVotes([b(1, 'spam'), b(2, 'spam'), b(3, 'spam'), b(9, 'spam', true)])
    expect(tally.decidedBy).toBe('admin')
  })

  it('is robust to garbage ballots', () => {
    const garbage = [
      { userId: Number.NaN, choice: 'spam', isAdmin: false },
      { userId: 1, choice: 'nonsense', isAdmin: false }
    ] as unknown as VoteBallot[]
    expect(tallyVotes(garbage).outcome).toBe('pending')
  })

  it('survives ballots that are not objects at all', () => {
    // These arrive from Mongo documents written by older code paths, so the
    // shape is not guaranteed by the type system at runtime.
    const junk = [
      null, undefined, 'spam', 42, [], { userId: 1 }, { choice: 'spam' },
      { userId: '1', choice: 'spam', isAdmin: false }
    ] as unknown as VoteBallot[]
    expect(() => tallyVotes(junk)).not.toThrow()
    expect(tallyVotes(junk).outcome).toBe('pending')
  })

  it('treats a non-array ballot list as no votes', () => {
    for (const notAnArray of [null, undefined, {}, 'ballots', 7]) {
      expect(tallyVotes(notAnArray as unknown as VoteBallot[]).outcome).toBe('pending')
    }
  })

  it('an admin re-voting the other way flips the outcome', () => {
    expect(tallyVotes([b(9, 'spam', true), b(9, 'ham', true)]).outcome).toBe('ham')
  })

  it('an admin ballot overrides a landslide in the other direction', () => {
    const landslide = [b(1, 'spam'), b(2, 'spam'), b(3, 'spam'), b(4, 'spam')]
    expect(tallyVotes(landslide).outcome).toBe('spam')
    expect(tallyVotes([...landslide, b(9, 'ham', true)]).outcome).toBe('ham')
  })

  it('honours a custom threshold', () => {
    expect(tallyVotes([b(1, 'spam')], 1).outcome).toBe('spam')
    expect(tallyVotes([b(1, 'spam'), b(2, 'spam')], 5).outcome).toBe('pending')
  })

  it('property: counts equal the number of distinct voters', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        userId: fc.integer({ min: 1, max: 6 }),
        choice: fc.constantFrom<'spam' | 'ham'>('spam', 'ham'),
        isAdmin: fc.boolean()
      }), { maxLength: 30 }),
      (ballots) => {
        const tally = tallyVotes(ballots)
        const distinct = new Set(ballots.map((x) => x.userId)).size
        return tally.spam + tally.ham === distinct
      }
    ))
  })

  it('property: ballot order never changes the counts', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        userId: fc.integer({ min: 1, max: 6 }),
        choice: fc.constantFrom<'spam' | 'ham'>('spam', 'ham'),
        isAdmin: fc.constant(false)
      }), { maxLength: 20 }),
      (ballots) => {
        // Admins excluded: for them "latest wins" makes order meaningful.
        const forward = tallyVotes(ballots)
        const reversed = tallyVotes([...ballots].reverse())
        return forward.spam + forward.ham === reversed.spam + reversed.ham
      }
    ))
  })
})

describe('voterRoster', () => {
  it('groups voters by the choice that counted, with their labels', () => {
    const roster = voterRoster([
      { userId: 1, choice: 'spam', isAdmin: false, label: 'Олег' },
      { userId: 2, choice: 'ham', isAdmin: false, label: 'Марія' }
    ])
    expect(roster.spam.map((v) => v.label)).toEqual(['Олег'])
    expect(roster.ham.map((v) => v.label)).toEqual(['Марія'])
  })

  it('lists a re-voter once, under their latest choice', () => {
    const roster = voterRoster([
      { userId: 1, choice: 'spam', isAdmin: false, label: 'Олег' },
      { userId: 1, choice: 'ham', isAdmin: false, label: 'Олег' }
    ])
    expect(roster.spam).toEqual([])
    expect(roster.ham).toHaveLength(1)
  })

  it('marks a voter who changed their mind', () => {
    const roster = voterRoster([
      { userId: 1, choice: 'spam', isAdmin: false },
      { userId: 1, choice: 'ham', isAdmin: false },
      { userId: 2, choice: 'ham', isAdmin: false }
    ])
    expect(roster.ham.find((v) => v.userId === 1)?.changedMind).toBe(true)
    expect(roster.ham.find((v) => v.userId === 2)?.changedMind).toBe(false)
  })

  it('does not call a double tap on the same button a change of mind', () => {
    const roster = voterRoster([
      { userId: 1, choice: 'spam', isAdmin: false },
      { userId: 1, choice: 'spam', isAdmin: false }
    ])
    expect(roster.spam).toHaveLength(1)
    expect(roster.spam[0]?.changedMind).toBe(false)
  })

  it('carries the admin marker', () => {
    const roster = voterRoster([{ userId: 9, choice: 'spam', isAdmin: true }])
    expect(roster.spam[0]?.isAdmin).toBe(true)
  })

  it('has no label for ballots written before labels were stored', () => {
    const roster = voterRoster([{ userId: 7, choice: 'spam', isAdmin: false }])
    expect(roster.spam[0]).toMatchObject({ userId: 7, label: null })
  })

  it('reports the seconds between the first and last ballot', () => {
    const roster = voterRoster([
      { userId: 1, choice: 'spam', isAdmin: false, at: new Date('2026-08-23T10:00:00Z') },
      { userId: 2, choice: 'spam', isAdmin: false, at: new Date('2026-08-23T10:04:00Z') }
    ])
    expect(roster.spanSeconds).toBe(240)
  })

  it('counts the span across superseded ballots too', () => {
    // The whole point of the span is how fast the votes arrived; a ballot that
    // was later replaced still arrived.
    const roster = voterRoster([
      { userId: 1, choice: 'spam', isAdmin: false, at: new Date('2026-08-23T10:00:00Z') },
      { userId: 1, choice: 'ham', isAdmin: false, at: new Date('2026-08-23T10:10:00Z') }
    ])
    expect(roster.spanSeconds).toBe(600)
  })

  it('has no span when the timestamps are missing or unusable', () => {
    expect(voterRoster([{ userId: 1, choice: 'spam', isAdmin: false }]).spanSeconds).toBeNull()
    expect(voterRoster([
      { userId: 1, choice: 'spam', isAdmin: false, at: 'not a date' as unknown as Date }
    ]).spanSeconds).toBeNull()
  })

  it('reads a timestamp Mongo handed back as a string', () => {
    const roster = voterRoster([
      { userId: 1, choice: 'spam', isAdmin: false, at: '2026-08-23T10:00:00Z' as unknown as Date },
      { userId: 2, choice: 'spam', isAdmin: false, at: '2026-08-23T10:00:30Z' as unknown as Date }
    ])
    expect(roster.spanSeconds).toBe(30)
  })

  it('survives a ballot list far too long to spread onto the stack', () => {
    // Nothing rate-limits taps and nothing caps the array, so `Math.max(...)`
    // over the timestamps was one determined account away from a RangeError
    // that would take the roster button down for everybody.
    const many = Array.from({ length: 200_000 }, (_, i) => ({
      userId: i % 50, choice: 'spam' as const, isAdmin: false, at: new Date(i * 1000)
    }))
    expect(() => voterRoster(many)).not.toThrow()
    expect(voterRoster(many).spanSeconds).toBe(199_999)
  })

  it('drops the same garbage tallyVotes drops', () => {
    const junk = [
      null, undefined, 'spam', 42, [], { userId: 1 }, { choice: 'spam' },
      { userId: Number.NaN, choice: 'spam', isAdmin: false },
      { userId: 1, choice: 'nonsense', isAdmin: false }
    ] as unknown as VoteBallot[]
    expect(() => voterRoster(junk)).not.toThrow()
    expect(voterRoster(junk)).toMatchObject({ spam: [], ham: [], spanSeconds: null })
  })

  it('treats a non-array ballot list as no voters', () => {
    for (const notAnArray of [null, undefined, {}, 'ballots', 7]) {
      expect(voterRoster(notAnArray as unknown as VoteBallot[]).spam).toEqual([])
    }
  })

  it('property: the roster names exactly the voters the tally counted', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        userId: fc.integer({ min: 1, max: 6 }),
        choice: fc.constantFrom<'spam' | 'ham'>('spam', 'ham'),
        isAdmin: fc.boolean()
      }), { maxLength: 30 }),
      (ballots) => {
        const tally = tallyVotes(ballots)
        const roster = voterRoster(ballots)
        return roster.spam.length === tally.spam && roster.ham.length === tally.ham
      }
    ))
  })
})

/**
 * Who may put a ballot in the box.
 *
 * The tally was never the weak part — it counts honestly what it is given. Both
 * abuse routes are upstream of it: a crew of three fresh accounts reaches the
 * net-3 threshold in either direction, and the target of a question could vote
 * on it, where a single "not spam" tap held the net difference below the
 * threshold and left the question open forever.
 */
describe('voteEligibility', () => {
  const voter = (over: Partial<VoterStanding> = {}): VoterStanding => ({
    isAdmin: false, isTarget: false, messagesInChat: 20, messagesGlobal: 200,
    localAgeDays: 30, joinedAgoSeconds: null, spamDetections: 0, ...over
  })

  it('a regular of this chat may vote', () => {
    expect(voteEligibility(voter({ messagesInChat: 10, messagesGlobal: 0 }))).toBe('eligible')
  })

  it('someone with volume elsewhere may vote in a chat they are new to', () => {
    expect(voteEligibility(voter({ messagesInChat: 0, messagesGlobal: 50 }))).toBe('eligible')
  })

  it('a newcomer may not vote', () => {
    expect(voteEligibility(voter({ messagesInChat: 2, messagesGlobal: 3, localAgeDays: 0 })))
      .toBe('no_standing')
  })

  it('volume farmed without tenure earns no vote', () => {
    // Three accounts can post ten messages each in five minutes; they cannot
    // make themselves a week old. Tenure is the half of the bar that costs.
    expect(voteEligibility(voter({ messagesInChat: 100, localAgeDays: 1 }))).toBe('no_standing')
  })

  it('months of tenure without volume earn no vote', () => {
    expect(voteEligibility(voter({ messagesInChat: 1, messagesGlobal: 4, localAgeDays: 100 })))
      .toBe('no_standing')
  })

  it('a year in the chat is standing by itself', () => {
    // Half of the refusals in the week to 2026-09-01 were members Telegram
    // dates to one to four years ago with nothing in counters that only exist
    // since June. Silence is not arrival.
    expect(voteEligibility(voter({ messagesInChat: 0, messagesGlobal: 0, localAgeDays: null,
      joinedAgoSeconds: VOTE_TENURE_ALONE_DAYS * 86400 }))).toBe('eligible')
    expect(voteEligibility(voter({ messagesInChat: 1, messagesGlobal: 4, localAgeDays: 400 })))
      .toBe('eligible')
  })

  it('a year of tenure does not restore a vote to a known-bad account', () => {
    expect(voteEligibility(voter({ localAgeDays: 400, spamDetections: 2 }))).toBe('known_bad')
  })

  it('an unknown tenure is not evidence of tenure', () => {
    expect(voteEligibility(voter({ localAgeDays: null }))).toBe('no_standing')
  })

  it('a member Telegram says joined months ago votes, though our record is a day old', () => {
    // The case this bar was refusing in production: a chat the bot was only
    // just added to, where every member's first-seen date is today and the
    // whole chat is therefore mute for a week. Telegram's join date is the one
    // fact that survives anything we do to our own database.
    expect(voteEligibility(voter({ localAgeDays: 1, joinedAgoSeconds: 90 * 86400 })))
      .toBe('eligible')
  })

  it('our own longer record still counts when Telegram says nothing', () => {
    expect(voteEligibility(voter({ localAgeDays: 30, joinedAgoSeconds: null })))
      .toBe('eligible')
  })

  it('the join date alone is enough when we have no record at all', () => {
    expect(voteEligibility(voter({ localAgeDays: null, joinedAgoSeconds: 30 * 86400 })))
      .toBe('eligible')
  })

  it('a join date of minutes ago does not lend tenure to a fresh record', () => {
    expect(voteEligibility(voter({ localAgeDays: 1, joinedAgoSeconds: 600 })))
      .toBe('no_standing')
  })

  it('neither clock saying anything is not tenure', () => {
    expect(voteEligibility(voter({ localAgeDays: null, joinedAgoSeconds: null })))
      .toBe('no_standing')
  })

  it('an admin may vote with no standing at all', () => {
    expect(voteEligibility(voter({
      isAdmin: true, messagesInChat: 0, messagesGlobal: 0, localAgeDays: null
    }))).toBe('eligible')
  })

  it('the person the question is about may never vote on it', () => {
    expect(voteEligibility(voter({ isTarget: true }))).toBe('is_target')
  })

  it('not even when they are an admin', () => {
    expect(voteEligibility(voter({ isTarget: true, isAdmin: true }))).toBe('is_target')
  })

  it('an account with prior confirmed detections may not vote', () => {
    expect(voteEligibility(voter({ spamDetections: 2 }))).toBe('known_bad')
  })

  it('one detection is not enough to take the vote away', () => {
    // Same bar the rest of the system uses: one detection may itself have been
    // a false positive.
    expect(voteEligibility(voter({ spamDetections: 1 }))).toBe('eligible')
  })

  it('an admin keeps the vote regardless of what is recorded against them', () => {
    expect(voteEligibility(voter({ isAdmin: true, spamDetections: 9 }))).toBe('eligible')
  })

  it('unusable counts read as no standing, never as standing', () => {
    for (const broken of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(voteEligibility(voter({
        messagesInChat: broken, messagesGlobal: broken,
        localAgeDays: broken, joinedAgoSeconds: broken
      }))).toBe('no_standing')
    }
  })
})

describe('voteMayRecordDetection', () => {
  it('a vote on words may be written down against the account', () => {
    expect(voteMayRecordDetection('заробіток від 5000 на день, пиши в лс')).toBe(true)
  })

  it('a vote on a wordless message may not', () => {
    // The ballot quoted nothing; the removal and the mute still stand, but the
    // durable counter that makes the next judgement harsher does not.
    expect(voteMayRecordDetection('')).toBe(false)
  })

  it('whitespace is not content', () => {
    expect(voteMayRecordDetection('   \n\t  ')).toBe(false)
  })

  it('one character is content — the bar here is "anything", not "enough"', () => {
    // Deliberately not the distinctiveness bar: that one governs what may be
    // LEARNED and fires globally. This governs one counter on one account, and
    // a single visible character is still something a voter read.
    expect(voteMayRecordDetection('?')).toBe(true)
  })
})

describe('expiryOutcome', () => {
  it('two unopposed spam voters take the message down at expiry', () => {
    expect(expiryOutcome({ spam: UNOPPOSED_EXPIRY_MIN_SPAM, ham: 0 })).toBe('delete')
    expect(expiryOutcome({ spam: 5, ham: 0 })).toBe('delete')
  })

  it('one voter is an opinion, not an outcome', () => {
    expect(expiryOutcome({ spam: 1, ham: 0 })).toBeNull()
    expect(expiryOutcome({ spam: 0, ham: 0 })).toBeNull()
  })

  it('a single dissent keeps the message', () => {
    expect(expiryOutcome({ spam: 4, ham: 1 })).toBeNull()
  })

  it('the tally it reads is per voter, so a repeated tap is still one voter', () => {
    const tally = tallyVotes([b(1, 'spam'), b(1, 'spam'), b(1, 'spam')])
    expect(expiryOutcome(tally)).toBeNull()
  })
})

describe('voterRoster — a deduplicated ballot carries its own change of mind', () => {
  it('reads the stored flag', () => {
    const roster = voterRoster([{ ...b(1, 'ham'), changedMind: true }])
    expect(roster.ham[0]?.changedMind).toBe(true)
  })

  it('a plain ballot is not a change of mind', () => {
    const roster = voterRoster([{ ...b(1, 'ham'), changedMind: false }])
    expect(roster.ham[0]?.changedMind).toBe(false)
  })
})
