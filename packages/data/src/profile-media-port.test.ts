import { describe, expect, it } from 'vitest'
import { MongoProfileMediaPort } from './profile-media-port.js'
import type { MongoStore } from './mongo.js'

/**
 * A picture with structure, so `isDegenerateHash` does not refuse it. Bits are
 * spread deliberately: half the nibbles set, which is what a photograph looks
 * like and what a blank avatar does not.
 */
const HASH = '9d8f9e0f6f6f6766'
/** One bit away — a re-encode of the same picture. */
const NEAR = '9d8f9e0f6f6f6767'
/** Nothing like it. */
const FAR = '0000ffff0000ffff'

interface Row { hash: string; userId: number }

const port = (rows: Row[]): {
  port: MongoProfileMediaPort
  writes: Record<string, unknown>[]
  queries: Record<string, unknown>[]
} => {
  const writes: Record<string, unknown>[] = []
  const queries: Record<string, unknown>[] = []
  const collection = {
    updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      writes.push({ filter, update })
    },
    find: (filter: Record<string, unknown>) => {
      queries.push(filter)
      return { toArray: async () => rows }
    }
  }
  const store = { profileMedia: () => collection } as unknown as MongoStore
  return { port: new MongoProfileMediaPort(store), writes, queries }
}

describe('MongoProfileMediaPort.seen', () => {
  it('reports another account wearing the same picture', async () => {
    const { port: p } = port([{ hash: HASH, userId: 222 }])
    await expect(p.seen(111, HASH)).resolves.toEqual({
      otherAccounts: 1, sampleUserIds: [222], closestDistance: 0
    })
  })

  it('accepts a re-encode a few bits away', async () => {
    const { port: p } = port([{ hash: NEAR, userId: 222 }])
    const hit = await p.seen(111, HASH)
    expect(hit?.otherAccounts).toBe(1)
    expect(hit?.closestDistance).toBe(1)
  })

  /**
   * The band lookup returns candidates, not matches — that is the whole point of
   * it. Rows that merely collide in one 16-bit band must be discarded by true
   * distance, or the signal would fire on unrelated pictures roughly once in
   * every 65,536 rows examined.
   */
  it('discards a band collision that is not the same picture', async () => {
    const { port: p } = port([{ hash: FAR, userId: 222 }])
    await expect(p.seen(111, HASH)).resolves.toBeNull()
  })

  /**
   * The write happens before the read, so the sender's own row is in the
   * candidate set by construction. Counting it would make every first sighting
   * report a match against itself.
   */
  it('never counts the sender against themselves', async () => {
    const { port: p } = port([{ hash: HASH, userId: 111 }])
    await expect(p.seen(111, HASH)).resolves.toBeNull()
  })

  it('counts accounts, not rows — one account with two near hashes is one account', async () => {
    const { port: p } = port([
      { hash: HASH, userId: 222 },
      { hash: NEAR, userId: 222 }
    ])
    const hit = await p.seen(111, HASH)
    expect(hit?.otherAccounts).toBe(1)
  })

  it('records the picture against the account, keyed so a repeat is not a new row', async () => {
    const { port: p, writes } = port([])
    await p.seen(111, HASH)
    expect(writes[0]?.['filter']).toEqual({ hash: HASH, userId: 111 })
    const update = writes[0]?.['update'] as Record<string, Record<string, unknown>>
    // First-seen must not be overwritten on every message.
    expect(update['$setOnInsert']).toHaveProperty('firstSeenAt')
    expect(update['$set']).toMatchObject({ hash: HASH, userId: 111 })
  })

  it('stores four bands and asks for a match in any of them', async () => {
    const { port: p, writes, queries } = port([])
    await p.seen(111, HASH)
    const set = (writes[0]?.['update'] as Record<string, Record<string, unknown>>)['$set']!
    expect(set['b0']).toBe('9d8f')
    expect(set['b1']).toBe('9e0f')
    expect(set['b2']).toBe('6f6f')
    expect(set['b3']).toBe('6766')
    expect(queries[0]).toEqual({
      $or: [{ b0: '9d8f' }, { b1: '9e0f' }, { b2: '6f6f' }, { b3: '6766' }]
    })
  })

  /**
   * The 2026-02 lesson: a normalisation that collapses unrelated inputs to one
   * value produces a store entry matching everything. A blank or single-colour
   * avatar is the image equivalent, and it must be refused on the way IN — after
   * it is stored, every lookup it takes part in is poisoned.
   */
  it('refuses a degenerate hash without storing or matching it', async () => {
    const { port: p, writes } = port([{ hash: '0000000000000000', userId: 222 }])
    await expect(p.seen(111, '0000000000000000')).resolves.toBeNull()
    await expect(p.seen(111, 'ffffffffffffffff')).resolves.toBeNull()
    expect(writes).toHaveLength(0)
  })

  it('refuses anything that is not a 64-bit hex hash', async () => {
    const { port: p, writes } = port([])
    for (const bad of ['', 'zzzz', HASH.toUpperCase(), HASH.slice(0, 8), HASH + '00']) {
      await expect(p.seen(111, bad)).resolves.toBeNull()
    }
    expect(writes).toHaveLength(0)
  })

  it('samples at most three accounts for the evidence line', async () => {
    const { port: p } = port(
      [1, 2, 3, 4, 5, 6].map((n) => ({ hash: HASH, userId: 200 + n }))
    )
    const hit = await p.seen(111, HASH)
    expect(hit?.otherAccounts).toBe(6)
    expect(hit?.sampleUserIds).toHaveLength(3)
  })

  /**
   * A store that cannot answer must cost the sender nothing. Everywhere else in
   * this pipeline a failed port degrades to "no answer", and an avatar lookup is
   * not the place to start throwing into the moderation path.
   */
  it('degrades to no answer when the store throws', async () => {
    const collection = {
      updateOne: async () => { throw new Error('mongo down') },
      find: () => ({ toArray: async () => { throw new Error('mongo down') } })
    }
    const store = { profileMedia: () => collection } as unknown as MongoStore
    await expect(new MongoProfileMediaPort(store).seen(111, HASH)).resolves.toBeNull()
  })

  it('ignores a stored row whose userId is not a usable number', async () => {
    const { port: p } = port([{ hash: HASH, userId: Number.NaN }])
    await expect(p.seen(111, HASH)).resolves.toBeNull()
  })
})
