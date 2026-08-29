import { describe, expect, it } from 'vitest'
import { createStatsCache } from './stats-cache.js'

/** A clock the test moves by hand, so nothing here waits on wall time. */
const clock = (): { now: () => number; advance: (ms: number) => void } => {
  let t = 1_000_000
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('createStatsCache', () => {
  it('reads the source once and serves that answer for the whole window', async () => {
    const time = clock()
    let loads = 0
    const cache = createStatsCache({
      ttlMs: 600_000, now: time.now, load: async () => { loads += 1; return loads }
    })
    expect(await cache.get('global')).toBe(1)
    time.advance(599_000)
    expect(await cache.get('global')).toBe(1)
    expect(loads).toBe(1)
  })

  it('goes back to the source once the window has passed', async () => {
    const time = clock()
    let loads = 0
    const cache = createStatsCache({
      ttlMs: 600_000, now: time.now, load: async () => { loads += 1; return loads }
    })
    await cache.get('global')
    time.advance(600_001)
    expect(await cache.get('global')).toBe(2)
  })

  /**
   * Mongo being briefly unreachable must not turn the card into "the bot has
   * done nothing". Yesterday's true figures beat today's blank.
   */
  it('serves the last good answer when the source fails', async () => {
    const time = clock()
    let attempt = 0
    const cache = createStatsCache({
      ttlMs: 1000,
      now: time.now,
      load: async () => {
        attempt += 1
        if (attempt > 1) throw new Error('mongo is having a moment')
        return 'good'
      }
    })
    expect(await cache.get('global')).toBe('good')
    time.advance(2000)
    expect(await cache.get('global')).toBe('good')
  })

  it('answers with nothing, rather than throwing, when it never had an answer', async () => {
    const cache = createStatsCache({
      ttlMs: 1000, load: async () => { throw new Error('down since boot') }
    })
    await expect(cache.get('global')).resolves.toBeNull()
  })

  /**
   * A busy chat can produce several taps inside one round trip. Each one used
   * to be its own scan of a fortnight of decisions.
   */
  it('collapses concurrent callers into one read', async () => {
    let loads = 0
    let release: () => void = () => { /* replaced below */ }
    const gate = new Promise<void>((resolve) => { release = resolve })
    const cache = createStatsCache({
      ttlMs: 1000,
      load: async () => { loads += 1; await gate; return loads }
    })
    const all = Promise.all([cache.get('k'), cache.get('k'), cache.get('k')])
    release()
    expect(await all).toEqual([1, 1, 1])
    expect(loads).toBe(1)
  })

  it('keeps different keys apart', async () => {
    const cache = createStatsCache({ ttlMs: 1000, load: async (key) => key.toUpperCase() })
    expect(await cache.get('a')).toBe('A')
    expect(await cache.get('b')).toBe('B')
  })

  /** One entry per chat, and this bot is in hundreds of them. */
  it('drops the oldest entries instead of growing without a bound', async () => {
    let loads = 0
    const cache = createStatsCache({
      ttlMs: 600_000, maxEntries: 2, load: async () => { loads += 1; return loads }
    })
    await cache.get('a')
    await cache.get('b')
    await cache.get('c')
    // 'a' was evicted, so asking again is a fresh read.
    await cache.get('a')
    expect(loads).toBe(4)
    expect(cache.size()).toBeLessThanOrEqual(2)
  })
})
