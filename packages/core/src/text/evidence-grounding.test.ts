import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { evidenceGrounding } from './evidence-grounding.js'

const ANSWERS = new Set(['quoted', 'paraphrased', 'absent', 'missing', 'no_text'])
const text = 'Нужны люди на удалённую работу, 300$ в день, пиши в личку'

describe('evidenceGrounding', () => {
  it('accepts a verbatim quote, whatever the case, quotes and spacing', () => {
    expect(evidenceGrounding('300$ в день', text)).toBe('quoted')
    expect(evidenceGrounding('«НУЖНЫ ЛЮДИ  на удалённую работу»', text)).toBe('quoted')
  })

  it('accepts a quote shortened with an ellipsis, piece by piece', () => {
    expect(evidenceGrounding('Нужны люди… пиши в личку', text)).toBe('quoted')
    expect(evidenceGrounding('Нужны люди ... пиши в личку', text)).toBe('quoted')
  })

  it('calls a reworded quote a paraphrase and an invented one absent', () => {
    expect(evidenceGrounding('удалённую работу пиши людям', text)).toBe('paraphrased')
    expect(evidenceGrounding('promises fast crypto profit', text)).toBe('absent')
  })

  it('separates no evidence from no text to quote', () => {
    expect(evidenceGrounding(null, text)).toBe('missing')
    expect(evidenceGrounding('  ', text)).toBe('missing')
    expect(evidenceGrounding('anything', '')).toBe('no_text')
    expect(evidenceGrounding('anything', '🔥🔥')).toBe('no_text')
  })

  it('property: any slice of three letters or more of a plain text is quoted', () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-zа-я]{3,60}$/), fc.nat(), fc.nat(), (s, a, b) => {
      const from = a % (s.length - 2)
      const slice = s.slice(from, from + 3 + (b % 20))
      expect(evidenceGrounding(slice, s)).toBe('quoted')
    }))
  })

  it('property: never throws and always answers from its five values, lone surrogates included', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 120 }), fc.string({ unit: 'binary', maxLength: 240 }), (e, t) =>
      ANSWERS.has(evidenceGrounding(e, t))
    ), { numRuns: 60 })
  }, 20_000)
})
