import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { tallyVotes, type VoteBallot } from './voting.js'

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
