import { describe, expect, it } from 'vitest'
import {
  parseCasExport,
  extractCasMessages,
  isHarvestableText,
  harvestCas
} from './cas-harvest.js'

describe('parseCasExport', () => {
  it('parses one id per line', () => {
    expect(parseCasExport('111\n222\n333')).toEqual([111, 222, 333])
  })

  it('ignores a header row and blank / garbage lines', () => {
    expect(parseCasExport('user_id\n111\n\n  222 \nboom\n-5\n0')).toEqual([111, 222])
  })

  it('returns an empty list for empty input', () => {
    expect(parseCasExport('')).toEqual([])
    expect(parseCasExport('   ')).toEqual([])
  })
})

describe('extractCasMessages', () => {
  it('pulls the spam texts out of a CAS check result', () => {
    const body = { ok: true, result: { messages: ['buy crypto now', 'join my channel'] } }
    expect(extractCasMessages(body)).toEqual(['buy crypto now', 'join my channel'])
  })

  it('drops non-string and empty entries', () => {
    const body = { ok: true, result: { messages: ['real', '', '  ', 42, null] } }
    expect(extractCasMessages(body)).toEqual(['real'])
  })

  it('degrades to an empty list on garbage', () => {
    expect(extractCasMessages(null)).toEqual([])
    expect(extractCasMessages({ ok: false })).toEqual([])
    expect(extractCasMessages('boom')).toEqual([])
  })
})

describe('isHarvestableText', () => {
  it('keeps texts long enough to decide on their own', () => {
    expect(isHarvestableText('this is a long enough spam advert line')).toBe(true)
  })

  it('rejects short greetings that would poison the signature store', () => {
    expect(isHarvestableText('доброго утра')).toBe(false)
    expect(isHarvestableText('')).toBe(false)
  })
})

describe('harvestCas', () => {
  const checkUrlId = (url: string): number => Number(new URL(url).searchParams.get('user_id'))

  const fetchFrom = (byId: Record<number, unknown | Error>) =>
    async (url: string): Promise<{ json: () => Promise<unknown> }> => {
      const body = byId[checkUrlId(url)]
      if (body instanceof Error) throw body
      return { json: async () => body }
    }

  const LONG = 'this is a sufficiently long spam advertisement message'

  it('learns qualifying texts and reports stats', async () => {
    const learned: string[] = []
    const stats = await harvestCas({
      ids: [10, 20],
      fetchImpl: fetchFrom({
        10: { ok: true, result: { messages: [LONG, 'hi'] } }, // 'hi' too short
        20: { ok: false }                                      // not banned / no messages
      }),
      learn: async (t) => { learned.push(t) },
      delayMs: 0
    })
    expect(learned).toEqual([LONG])
    expect(stats).toEqual({ usersProcessed: 2, usersWithMessages: 1, textsLearned: 1, lastProcessedId: 20 })
  })

  it('caps the number of messages taken per user', async () => {
    const learned: string[] = []
    const many = Array.from({ length: 20 }, (_, i) => `${LONG} ${i}`)
    await harvestCas({
      ids: [10],
      fetchImpl: fetchFrom({ 10: { ok: true, result: { messages: many } } }),
      learn: async (t) => { learned.push(t) },
      maxPerUser: 3,
      delayMs: 0
    })
    expect(learned).toHaveLength(3)
  })

  it('keeps going when one user lookup fails', async () => {
    const learned: string[] = []
    const stats = await harvestCas({
      ids: [10, 20],
      fetchImpl: fetchFrom({ 10: new Error('boom'), 20: { ok: true, result: { messages: [LONG] } } }),
      learn: async (t) => { learned.push(t) },
      delayMs: 0
    })
    expect(learned).toEqual([LONG])
    expect(stats.usersProcessed).toBe(2)
  })

  it('stops early and remembers the last id when asked', async () => {
    const learned: string[] = []
    let processed = 0
    const stats = await harvestCas({
      ids: [10, 20, 30],
      fetchImpl: fetchFrom({
        10: { ok: true, result: { messages: [LONG] } },
        20: { ok: true, result: { messages: [LONG] } },
        30: { ok: true, result: { messages: [LONG] } }
      }),
      learn: async (t) => { learned.push(t) },
      delayMs: 0,
      shouldStop: () => processed++ >= 1 // allow one, then stop
    })
    expect(stats.usersProcessed).toBe(1)
    expect(stats.lastProcessedId).toBe(10)
  })
})
