import { describe, expect, it } from 'vitest'
import { createNoVotersShadow, NO_VOTERS_CACHE_TTL_MS } from './novoters-shadow.js'

const harness = (voters: () => Promise<number>) => {
  let t = 1_000_000
  const loads: [number, number][] = []
  const stamps: [number, number, unknown][] = []
  const flagged: number[] = []
  const probe = createNoVotersShadow({
    load: async (chatId, messageId) => { loads.push([chatId, messageId]); return voters() },
    stamp: async (chatId, messageId, s) => { stamps.push([chatId, messageId, s]) },
    onNoVoters: (_chatId, messageId) => { flagged.push(messageId) },
    now: () => t,
    maxEntries: 2
  })
  return { probe, loads, stamps, flagged, advance: (ms: number) => { t += ms } }
}

describe('createNoVotersShadow', () => {
  it('stamps and flags a chat where nobody answered', async () => {
    const h = harness(async () => 0)
    const stamp = await h.probe(-100, 5)
    expect(stamp?.shadowNoVoters).toBe(true)
    expect(h.loads).toEqual([[-100, 5]])
    expect(h.stamps).toHaveLength(1)
    expect(h.flagged).toEqual([5])
  })

  it('stamps but does not flag a chat with voters', async () => {
    const h = harness(async () => 4)
    expect((await h.probe(-100, 5))?.recentVoters).toBe(4)
    expect(h.stamps).toHaveLength(1)
    expect(h.flagged).toEqual([])
  })

  it('reads a chat once an hour and stamps every question', async () => {
    const h = harness(async () => 0)
    await h.probe(-100, 5)
    h.advance(NO_VOTERS_CACHE_TTL_MS - 1)
    await h.probe(-100, 6)
    expect(h.loads).toHaveLength(1)
    expect(h.stamps.map((s) => s[1])).toEqual([5, 6])
    h.advance(2)
    await h.probe(-100, 7)
    expect(h.loads).toHaveLength(2)
  })

  it('a failed read stamps nothing and is not remembered as zero', async () => {
    let fail = true
    const h = harness(async () => { if (fail) throw new Error('down'); return 0 })
    expect(await h.probe(-100, 5)).toBeNull()
    expect(h.stamps).toEqual([])
    expect(h.flagged).toEqual([])
    fail = false
    expect((await h.probe(-100, 6))?.shadowNoVoters).toBe(true)
    expect(h.loads).toHaveLength(2)
  })

  it('stays bounded across many chats', async () => {
    const h = harness(async () => 1)
    await h.probe(-1, 1)
    await h.probe(-2, 1)
    await h.probe(-3, 1)
    await h.probe(-1, 2) // evicted, so read again
    expect(h.loads.map((l) => l[0])).toEqual([-1, -2, -3, -1])
  })
})
