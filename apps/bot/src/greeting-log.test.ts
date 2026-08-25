import { describe, expect, it } from 'vitest'
import { GreetingLog } from './greeting-log.js'

const clock = (start = 1_000): { now: () => number; advance: (ms: number) => void } => {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('GreetingLog', () => {
  it('returns the greeting posted for a single joiner', () => {
    const log = new GreetingLog()
    log.remember(-100, [7], [42], 60_000)
    expect(log.take(-100, 7)).toEqual({ messageIds: [42], subjects: 1 })
  })

  it('keeps every message the greeting occupied (gif plus caption)', () => {
    const log = new GreetingLog()
    log.remember(-100, [7], [42, 43], 60_000)
    expect(log.take(-100, 7)?.messageIds).toEqual([42, 43])
  })

  it('reports how many people a bulk greeting named', () => {
    const log = new GreetingLog()
    log.remember(-100, [7, 8, 9], [42], 60_000)
    expect(log.take(-100, 8)?.subjects).toBe(3)
  })

  it('forgets the greeting for everyone it named, not just the taker', () => {
    // One message: taking it for the spammer must not leave the other two
    // holding a live reference to a message that is already gone.
    const log = new GreetingLog()
    log.remember(-100, [7, 8, 9], [42], 60_000)
    log.take(-100, 7)
    expect(log.take(-100, 8)).toBeNull()
    expect(log.take(-100, 9)).toBeNull()
  })

  it('forgets a greeting once taken, so a refused delete is not retried', () => {
    const log = new GreetingLog()
    log.remember(-100, [7], [42], 60_000)
    log.take(-100, 7)
    expect(log.take(-100, 7)).toBeNull()
  })

  it('returns null past the chat welcome timer — the scheduler already took it', () => {
    const c = clock()
    const log = new GreetingLog(c.now)
    log.remember(-100, [7], [42], 60_000)
    c.advance(60_001)
    expect(log.take(-100, 7)).toBeNull()
  })

  it('is per chat and per user', () => {
    const log = new GreetingLog()
    log.remember(-100, [7], [42], 60_000)
    expect(log.take(-200, 7)).toBeNull()
    expect(log.take(-100, 8)).toBeNull()
    expect(log.take(-100, 7)).not.toBeNull()
  })

  it('stores nothing when the greeting failed to send', () => {
    const log = new GreetingLog()
    log.remember(-100, [7], [], 60_000)
    expect(log.take(-100, 7)).toBeNull()
  })

  it('drops expired entries before evicting live ones when it grows', () => {
    const c = clock()
    const log = new GreetingLog(c.now, { maxTracked: 3 })
    for (const id of [1, 2, 3]) log.remember(-100, [id], [id], 60_000)
    c.advance(60_001)
    // The three below are live; the three above are not and must go first,
    // so nothing live is evicted even though the cap is reached each time.
    for (const id of [4, 5, 6]) log.remember(-100, [id], [id], 60_000)
    for (const id of [4, 5, 6]) expect(log.take(-100, id)).not.toBeNull()
  })

  it('stays bounded when every greeting is still live', () => {
    const log = new GreetingLog(Date.now, { maxTracked: 2 })
    for (const id of [1, 2, 3, 4, 5]) log.remember(-100, [id], [id], 60_000)
    // Oldest-inserted go first; the newest survive.
    expect(log.take(-100, 1)).toBeNull()
    expect(log.take(-100, 5)).not.toBeNull()
  })
})
