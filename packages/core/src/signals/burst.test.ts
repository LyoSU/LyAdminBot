import { describe, expect, it } from 'vitest'
import { BURST_GREY_FLOOR, burstBlob, burstSignals } from './burst.js'
import { LLM_GREY_LOW } from '../pipeline.js'
import type { BurstEntry } from '../ports.js'

const entry = (over: Partial<BurstEntry> = {}): BurstEntry => ({
  text: 'щось написане в чаті',
  template: 'щось написане в чаті',
  pSpam: 0.1,
  at: Date.now(),
  ...over
})

const names = (entries: BurstEntry[]): string[] => burstSignals(entries).map((s) => s.name)

describe('burst signals', () => {
  it('the grey floor is the pipeline\'s grey floor', () => {
    // Two names for one calibrated number, in two modules that cannot import
    // each other without a cycle. Pinned here so the pair cannot drift: the app
    // layer's retro-purge asks "did the pipeline think this was clean" and has
    // to get the same answer the classifier gate gets.
    expect(BURST_GREY_FLOOR).toBe(LLM_GREY_LOW)
  })

  it('a quiet sender raises nothing at all', () => {
    expect(burstSignals([])).toEqual([])
    expect(names([entry()])).toEqual([])
  })

  it('two distinct preceding messages make a burst — three counting this one', () => {
    const signals = burstSignals([
      entry({ template: 'перше' }),
      entry({ template: 'друге' })
    ])
    expect(signals.map((s) => s.name)).toEqual(['sender_burst'])
    expect(signals[0]?.evidence).toContain('2 distinct')
  })

  it('REGRESSION: copies of one text are one message, not three', () => {
    // `velocity_repeats` (1.5, evidence) already charges for the same text
    // arriving repeatedly. Counting those copies again here would price one fact
    // twice — the double-billing the newness group cap exists to undo — and it
    // would do it on the pipeline's most false-positive-prone input.
    expect(names([
      entry({ template: 'той самий текст' }),
      entry({ template: 'той самий текст' }),
      entry({ template: 'той самий текст' })
    ])).toEqual([])
  })

  it('media-only entries carry no template and cannot make a burst distinct', () => {
    // A photo offers nothing to compare, and inventing a distinction between two
    // photos would be inventing evidence. A run of pure media is left to
    // `burst_grey_repeat`, which reads what the pipeline scored them.
    expect(names([
      entry({ text: '', template: '' }),
      entry({ text: '', template: '' }),
      entry({ text: '', template: '' })
    ])).toEqual([])
  })

  it('two greys in the window raise the second signal', () => {
    const signals = burstSignals([
      entry({ template: 'а', pSpam: 0.4 }),
      entry({ template: 'б', pSpam: 0.6 }),
      entry({ template: 'в', pSpam: 0.1 })
    ])
    expect(signals.map((s) => s.name)).toEqual(['sender_burst', 'burst_grey_repeat'])
    expect(signals[1]?.evidence).toContain('2 of 3')
  })

  it('one grey is not a pattern', () => {
    expect(names([
      entry({ template: 'а', pSpam: 0.9 }),
      entry({ template: 'б', pSpam: 0.05 })
    ])).toEqual(['sender_burst'])
  })

  it('the floor is inclusive — exactly 0.35 counts', () => {
    expect(names([
      entry({ template: 'а', pSpam: BURST_GREY_FLOOR }),
      entry({ template: 'б', pSpam: BURST_GREY_FLOOR })
    ])).toContain('burst_grey_repeat')
  })
})

describe('burstBlob', () => {
  const grey = entry({ text: 'є робота для всіх', template: 'є робота для всіх', pSpam: 0.5 })

  it('needs three messages counting the current one', () => {
    expect(burstBlob([grey], 'пиши в особисті')).toBeNull()
    expect(burstBlob([grey, entry({ text: 'умови прості' })], 'пиши в особисті')).not.toBeNull()
  })

  it('needs at least one message the pipeline was already unsure about', () => {
    // Otherwise this is a bill for every three-message exchange in every chat.
    const calm = [entry({ pSpam: 0.05 }), entry({ pSpam: 0.1 })]
    expect(burstBlob(calm, 'а ти як')).toBeNull()
  })

  it('joins the window and the current message, oldest first', () => {
    const blob = burstBlob([grey, entry({ text: 'умови прості' })], 'пиши в особисті')
    expect(blob?.text).toBe('є робота для всіх\nумови прості\nпиши в особисті')
    expect(blob?.count).toBe(3)
  })

  it('REGRESSION: never hands the classifier a blob of empty lines', () => {
    // 2026-08-01: the session window appended empty strings for photos and
    // stickers until five of them filled it, and the model was then asked to
    // classify "\n\n\n\n" — and answered. Media counts toward the signals and
    // never toward the text.
    const media = [
      entry({ text: '', template: '', pSpam: 0.5 }),
      entry({ text: '', template: '' })
    ]
    expect(burstBlob(media, '')).toBeNull()
    // One real line with empty neighbours is not a burst either: the blob has to
    // be the thing that carries the meaning.
    expect(burstBlob(media, 'пиши в особисті')).toBeNull()
  })

  it('a blob too short to mean anything is not worth a call', () => {
    const tiny = [entry({ text: 'ок', template: 'ок', pSpam: 0.5 }), entry({ text: 'ага', template: 'ага' })]
    expect(burstBlob(tiny, 'ну')).toBeNull()
  })
})
