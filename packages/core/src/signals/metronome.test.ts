import { describe, expect, it } from 'vitest'
import { metronomeShape } from './metronome.js'

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
