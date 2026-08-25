import { describe, expect, it } from 'vitest'
import { MongoProfileMediaPort } from './profile-media-port.js'
import type { MongoStore } from './mongo.js'

/**
 * A picture with structure, so `isDegenerateHash` does not refuse it. Bits are
 * spread deliberately: half the nibbles set, which is what a photograph looks
 * like and what a blank avatar does not.
 */
const HASH = '9d8f9e0f6f6f6766'
/** A different picture, used to check that a second write happens. */
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
    await expect(p.seen(111, HASH)).resolves.toEqual({ otherAccounts: 1, sampleUserIds: [222] })
  })

  /**
   * An exact hash match, deliberately — see the port's own note. dHash is stable
   * across the re-encodes that actually happen (640px and 320px of one photo
   * hash identically), and both re-use clusters found on real banned accounts
   * were byte-identical files. Paying four index entries per row to tolerate a
   * drift the data does not show would cost more index than document.
   */
  it('asks for the hash itself, served by the unique key prefix', async () => {
    const { port: p, queries } = port([])
    await p.seen(111, HASH)
    expect(queries[0]).toEqual({ hash: HASH })
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

  it('counts accounts, not rows', async () => {
    const { port: p } = port([
      { hash: HASH, userId: 222 },
      { hash: HASH, userId: 222 }
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

  /**
   * The lookup runs on every message from a newish sender; the write only has to
   * happen when something changed. On a 512 MB tier that is the difference
   * between a write per message and a write per sender.
   */
  it('writes once per sender and picture, then only reads', async () => {
    const { port: p, writes, queries } = port([])
    await p.seen(111, HASH)
    await p.seen(111, HASH)
    await p.seen(111, HASH)
    expect(writes).toHaveLength(1)
    expect(queries).toHaveLength(3)
  })

  it('writes again when the same sender changes picture', async () => {
    const { port: p, writes } = port([])
    await p.seen(111, HASH)
    await p.seen(111, FAR)
    expect(writes).toHaveLength(2)
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
