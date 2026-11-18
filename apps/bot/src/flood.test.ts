import { describe, expect, it } from 'vitest'
import { FloodTracker } from './flood.js'

describe('FloodTracker', () => {
  it('counts a sender’s messages inside the window, this one included', () => {
    const t = new FloodTracker()
    expect(t.note(1, 7, 0, 10_000)).toBe(1)
    expect(t.note(1, 7, 3_000, 10_000)).toBe(2)
    expect(t.note(1, 7, 9_000, 10_000)).toBe(3)
    // The first message has left the 10-second window.
    expect(t.note(1, 7, 12_000, 10_000)).toBe(3)
  })

  it('keeps chats and senders apart', () => {
    const t = new FloodTracker()
    t.note(1, 7, 0, 10_000)
    expect(t.note(2, 7, 1, 10_000)).toBe(1)
    expect(t.note(1, 8, 1, 10_000)).toBe(1)
  })

  it('stays bounded under a raid of one-message accounts', () => {
    const t = new FloodTracker(100)
    for (let i = 0; i < 1000; i++) t.note(1, i, i, 10_000)
    expect(t.size).toBeLessThanOrEqual(100)
  })
})
