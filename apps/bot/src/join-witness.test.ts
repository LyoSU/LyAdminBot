import { describe, expect, it } from 'vitest'
import { JoinWitness } from './join-witness.js'

describe('JoinWitness', () => {
  const t0 = Date.UTC(2026, 8, 28, 10)
  const min = 60 * 1000

  it('lets the first report of a join act, and not the second', () => {
    const w = new JoinWitness()
    expect(w.claim(-1, 7, 'line', t0)).toBe(true)
    expect(w.claim(-1, 7, 'member', t0 + 5000)).toBe(false)
    expect(w.claim(-1, 7, 'line', t0 + 6000)).toBe(false)
  })

  it('keeps joins of the same person to different chats apart', () => {
    const w = new JoinWitness()
    expect(w.claim(-1, 7, 'member', t0)).toBe(true)
    expect(w.claim(-2, 7, 'member', t0)).toBe(true)
  })

  it('treats a rejoin after the window as a new join', () => {
    const w = new JoinWitness()
    expect(w.claim(-1, 7, 'line', t0)).toBe(true)
    expect(w.claim(-1, 7, 'line', t0 + 11 * min)).toBe(true)
  })

  it('counts each join once it settles, by which reports reached us', () => {
    const w = new JoinWitness()
    w.claim(-1, 1, 'line', t0)
    w.claim(-1, 1, 'member', t0 + 1000)
    w.claim(-1, 2, 'line', t0)
    w.claim(-3, 3, 'member', t0)
    w.claim(-3, 4, 'member', t0)
    expect(w.pending(t0 + min)).toBe(0)
    expect(w.drain(t0 + 11 * min)).toEqual({ lineOnly: 1, memberOnly: 2, both: 1, top: ['-3:2'] })
    expect(w.drain(t0 + 12 * min)).toEqual({ lineOnly: 0, memberOnly: 0, both: 0, top: [] })
  })

  it('does not count a join still inside its window', () => {
    const w = new JoinWitness()
    w.claim(-1, 1, 'member', t0)
    expect(w.drain(t0 + min).memberOnly).toBe(0)
    w.claim(-1, 1, 'line', t0 + 2 * min)
    expect(w.drain(t0 + 11 * min)).toMatchObject({ both: 1, memberOnly: 0 })
  })

  it('stays bounded, counting what it drops', () => {
    const w = new JoinWitness(10 * min, 100)
    for (let i = 0; i < 250; i++) w.claim(-1, i, 'line', t0)
    expect(w.drain(t0).lineOnly).toBe(150)
    expect(w.drain(t0 + 11 * min).lineOnly).toBe(100)
  })
})
