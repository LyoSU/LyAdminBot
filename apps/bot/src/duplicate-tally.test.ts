import { describe, it, expect } from 'vitest'
import { DuplicateTally } from './duplicate-tally.js'

describe('DuplicateTally', () => {
  it('counts per chat and names the busiest first', () => {
    const tally = new DuplicateTally()
    for (let i = 0; i < 3; i += 1) tally.note(-100)
    tally.note(-200)
    for (let i = 0; i < 7; i += 1) tally.note(-300)

    const summary = tally.drain()
    expect(summary.total).toBe(11)
    expect(summary.chats).toBe(3)
    expect(summary.top).toEqual(['-300:7', '-100:3', '-200:1'])
  })

  it('a quiet window reports nothing to say', () => {
    const tally = new DuplicateTally()
    expect(tally.pending).toBe(0)
    tally.note(-100)
    expect(tally.pending).toBe(1)
  })

  /**
   * A window reported twice would read as a doubling rate — which is exactly
   * the reading this instrument exists to produce honestly.
   */
  it('draining empties the window', () => {
    const tally = new DuplicateTally()
    tally.note(-100)
    tally.note(-100)
    expect(tally.drain().total).toBe(2)
    expect(tally.pending).toBe(0)
    expect(tally.drain()).toEqual({ total: 0, chats: 0, top: [] })
  })

  it('names at most ten chats however many arrived', () => {
    const tally = new DuplicateTally()
    for (let chat = 1; chat <= 25; chat += 1) {
      for (let n = 0; n < chat; n += 1) tally.note(-chat)
    }
    const summary = tally.drain()
    expect(summary.chats).toBe(25)
    expect(summary.top).toHaveLength(10)
    expect(summary.top[0]).toBe('-25:25')
  })
})
