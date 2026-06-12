import { describe, expect, it } from 'vitest'
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
})
