import { describe, expect, it } from 'vitest'
import { metronomeShape, trailingMetronome } from './metronome.js'

const every = (n: number, gapMs: number, jitter = 0) =>
  Array.from({ length: n }, (_, i) => 1_000_000 + i * gapMs + (i % 2 ? jitter : 0))

describe('metronomeShape', () => {
  it('reads a steady cadence with small jitter', () => {
    const s = metronomeShape(every(10, 370_000, 8_000))
    expect(s?.messages).toBe(10)
    expect(Math.abs(s!.meanGapSec - 370)).toBeLessThan(10)
    expect(s!.cv).toBeLessThan(0.1)
  })
  it('needs six messages', () => {
    expect(metronomeShape(every(5, 370_000))).toBeNull()
    expect(metronomeShape(every(6, 370_000))).not.toBeNull()
  })
  it('does not read an irregular human rhythm', () => {
    const t = [0, 40_000, 400_000, 420_000, 1_500_000, 1_530_000, 2_900_000].map((x) => x + 1_000_000)
    expect(metronomeShape(t)).toBeNull()
  })
  it('leaves a flood to burst and a long silence to a new visit', () => {
    expect(metronomeShape(every(8, 5_000))).toBeNull()
    expect(metronomeShape(every(8, 4_000_000))).toBeNull()
  })
  it('collapses duplicate instants and ignores order', () => {
    const t = every(8, 300_000)
    expect(metronomeShape([...t, ...t].reverse())?.messages).toBe(8)
  })
})

describe('trailingMetronome', () => {
  const MIN = 60_000
  const steady = (n: number, from: number, gap = 7 * MIN) => Array.from({ length: n }, (_, i) => from + i * gap)

  it('reads the newest unbroken run, so an old pause does not void it', () => {
    // An hour and a half off, then a seven-minute timer.
    const times = [0, 5 * MIN, ...steady(8, 100 * MIN)]
    expect(metronomeShape(times)).toBeNull()
    expect(trailingMetronome(times)).toMatchObject({ messages: 8, meanGapSec: 420 })
  })

  it('a pause at the end leaves too short a run', () => {
    const times = [...steady(8, 0), 8 * 7 * MIN + 2 * 3_600_000]
    expect(trailingMetronome(times)).toBeNull()
  })

  it('an irregular run is no timer', () => {
    expect(trailingMetronome([0, 1, 9, 10, 25, 26, 40].map((m) => m * MIN))).toBeNull()
  })

  it('fewer than six copies is not a cadence yet', () => {
    expect(trailingMetronome(steady(5, 0))).toBeNull()
  })

  it('order and duplicates do not matter', () => {
    const times = steady(7, 0)
    expect(trailingMetronome([...times].reverse().concat(times[3]!))).toMatchObject({ messages: 7 })
  })
})
