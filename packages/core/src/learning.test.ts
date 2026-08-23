import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { DecidedBy, Verdict } from './types.js'
import {
  shouldAutoLearn, autoLearnSource, AUTO_LEARN_DECIDED_BY, AUTO_LEARN_MIN_LENGTH,
  isDistinctive, MIN_DISTINCTIVE_LENGTH, VOTE_LEARN_STATUS
} from './learning.js'

const makeVerdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  pSpam: 0.99, action: 'ban', needsVote: false, banDurationSeconds: null,
  decidedBy: 'llm', ruleId: null, signals: [], reasonCode: 'job_scam',
  reasonEvidence: null, meta: {},
  ...overrides
})

const longText = 'x'.repeat(AUTO_LEARN_MIN_LENGTH)

const ALL_STAGES: DecidedBy[] = [
  'custom_rule', 'deterministic', 'forward', 'signature', 'vector', 'velocity',
  'moderation', 'llm', 'llm_cached', 'session', 'score', 'abstain', 'error'
]

describe('shouldAutoLearn', () => {
  it('learns from a confident LLM verdict', () => {
    expect(shouldAutoLearn(makeVerdict(), longText)).toBe(true)
  })

  it('learns from a cached LLM verdict too — the text is no less spam', () => {
    expect(shouldAutoLearn(makeVerdict({ decidedBy: 'llm_cached' }), longText)).toBe(true)
  })

  it('NEVER learns from account-shape scoring', () => {
    // The false-positive class the 2026-07-27 review was about: a verdict that
    // never read the message. Writing those texts into the store would make
    // ordinary sentences match forever.
    expect(shouldAutoLearn(makeVerdict({ decidedBy: 'score' }), longText)).toBe(false)
  })

  it('NEVER learns from deterministic rules', () => {
    // Their highest-volume rule condemns the account, not the text: listed
    // accounts mostly post conversational filler to look human.
    expect(shouldAutoLearn(makeVerdict({ decidedBy: 'deterministic' }), longText)).toBe(false)
  })

  it.each(ALL_STAGES.filter((s) => !AUTO_LEARN_DECIDED_BY.has(s)))(
    'does not learn from %s', (decidedBy) => {
      expect(shouldAutoLearn(makeVerdict({ decidedBy }), longText)).toBe(false)
    })

  it('requires near-certainty', () => {
    expect(shouldAutoLearn(makeVerdict({ pSpam: 0.94 }), longText)).toBe(false)
    expect(shouldAutoLearn(makeVerdict({ pSpam: 0.95 }), longText)).toBe(true)
  })

  it('refuses short or whitespace-padded texts', () => {
    expect(shouldAutoLearn(makeVerdict(), 'коротко')).toBe(false)
    expect(shouldAutoLearn(makeVerdict(), '🍆')).toBe(false)
    expect(shouldAutoLearn(makeVerdict(), '')).toBe(false)
    expect(shouldAutoLearn(makeVerdict(), `   ${'y'.repeat(10)}   `)).toBe(false)
  })

  it('measures length after trimming, not before', () => {
    const padded = `${' '.repeat(200)}short${' '.repeat(200)}`
    expect(shouldAutoLearn(makeVerdict(), padded)).toBe(false)
  })

  it('a degenerate pSpam never authorises learning', () => {
    for (const pSpam of [Number.NaN, Infinity, -Infinity]) {
      expect(shouldAutoLearn(makeVerdict({ pSpam }), longText), String(pSpam)).toBe(false)
    }
  })

  it('property: never learns outside the whitelist, whatever the score or text', () => {
    fc.assert(fc.property(
      fc.constantFrom(...ALL_STAGES),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.string(),
      (decidedBy, pSpam, text) => {
        const learn = shouldAutoLearn(makeVerdict({ decidedBy, pSpam }), text)
        return !learn || AUTO_LEARN_DECIDED_BY.has(decidedBy)
      }
    ))
  })

  it('property: learning implies both a confident score and a substantial text', () => {
    fc.assert(fc.property(
      fc.constantFrom(...ALL_STAGES),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.string(),
      (decidedBy, pSpam, text) => {
        if (!shouldAutoLearn(makeVerdict({ decidedBy, pSpam }), text)) return true
        return pSpam >= 0.95 && text.trim().length >= AUTO_LEARN_MIN_LENGTH
      }
    ))
  })
})

describe('isDistinctive', () => {
  it('is the single bar shared by signatures, vectors and auto-learn', () => {
    expect(MIN_DISTINCTIVE_LENGTH).toBe(AUTO_LEARN_MIN_LENGTH)
    expect(isDistinctive('доброго ранку')).toBe(false)
    expect(isDistinctive('x'.repeat(MIN_DISTINCTIVE_LENGTH))).toBe(true)
  })

  it('measures the trimmed text', () => {
    expect(isDistinctive(`${' '.repeat(100)}коротко${' '.repeat(100)}`)).toBe(false)
  })
})

describe('autoLearnSource', () => {
  it('records the stage and reason so a bad entry can be traced back', () => {
    expect(autoLearnSource(makeVerdict({ decidedBy: 'llm', reasonCode: 'job_scam' })))
      .toBe('auto:llm:job_scam')
  })

  it('is distinguishable from human-confirmed sources', () => {
    expect(autoLearnSource(makeVerdict()).startsWith('auto:')).toBe(true)
  })
})

describe('VOTE_LEARN_STATUS', () => {
  it('is a candidate, so no vote can mint a deciding rule by itself', () => {
    // The guard is the constant's value, not any logic around it: promotion is
    // the signature port's job and it needs a second, independent chat.
    expect(VOTE_LEARN_STATUS).toBe('candidate')
  })
})
