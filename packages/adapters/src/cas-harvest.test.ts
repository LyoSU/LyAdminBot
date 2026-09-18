import { describe, expect, it } from 'vitest'
import {
  parseCasExport,
  extractCasMessages,
  extractCasRecord,
  isHarvestableText,
  harvestCas,
  recentBans
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

  it('keeps the export order — it is the order the bans were added in', () => {
    // Measured 2026-09-18 on the live export (1.27M lines): ids are not
    // sorted (617 of 1269 sampled neighbours ascend, i.e. coin-flip), while
    // `time_added` rises monotonically from the head to the tail. The tail IS
    // the recent past; sorting by id throws that away.
    expect(parseCasExport('333\n111\n222')).toEqual([333, 111, 222])
  })
})

describe('extractCasRecord', () => {
  it('reads the texts and when the ban was added', () => {
    const body = { ok: true, result: { messages: ['x'], offenses: 1, reasons: [1], time_added: '2026-08-22T23:28:21.000Z' } }
    expect(extractCasRecord(body)).toEqual({ messages: ['x'], timeAdded: new Date('2026-08-22T23:28:21.000Z') })
  })

  it('has no time when the field is missing or unreadable', () => {
    expect(extractCasRecord({ ok: true, result: { messages: ['x'] } }).timeAdded).toBeNull()
    expect(extractCasRecord({ ok: true, result: { messages: ['x'], time_added: 'yesterday' } }).timeAdded).toBeNull()
    expect(extractCasRecord(null)).toEqual({ messages: [], timeAdded: null })
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
    expect(stats).toEqual({ usersProcessed: 2, usersWithMessages: 1, textsLearned: 1, lastProcessedId: 20, newestTimeAdded: null })
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

  it('stops the walk where the caller says the past begins, and reports the newest ban time seen', async () => {
    // Walking the export from its tail: newest ban first, older with every
    // step. The caller ends the walk at a time it has already covered or that
    // is older than it cares about; a record with no readable time cannot end
    // it, because a missing field is not evidence of age.
    const learned: string[] = []
    const stats = await harvestCas({
      ids: [30, 20, 15, 10],
      fetchImpl: fetchFrom({
        30: { ok: true, result: { messages: [LONG + ' c'], time_added: '2026-09-17T10:00:00.000Z' } },
        20: { ok: true, result: { messages: [LONG + ' b'], time_added: 'garbage' } },
        15: { ok: true, result: { messages: [LONG + ' a'], time_added: '2026-09-10T10:00:00.000Z' } },
        10: { ok: true, result: { messages: [LONG + ' z'], time_added: '2026-09-01T10:00:00.000Z' } }
      }),
      learn: async (t) => { learned.push(t) },
      delayMs: 0,
      until: (record) => record.timeAdded !== null && record.timeAdded < new Date('2026-09-15T00:00:00.000Z')
    })
    // 30 learned, 20 learned (no time — walk goes on), 15 is older than the
    // bound: not learned, walk ends, 10 never fetched.
    expect(learned).toEqual([LONG + ' c', LONG + ' b'])
    expect(stats.usersProcessed).toBe(2)
    expect(stats.newestTimeAdded).toBe('2026-09-17T10:00:00.000Z')
  })
})

describe('recentBans', () => {
  const at = (iso: string) => ({ messages: [], timeAdded: new Date(iso) })

  it('measures the window back from the newest ban in the export, not from the clock', () => {
    // A file last regenerated weeks ago still has a recent past of its own.
    const until = recentBans({ sinceDays: 7, processedThrough: null })
    expect(until(at('2026-08-22T23:00:00Z'))).toBe(false) // anchor
    expect(until(at('2026-08-17T00:00:00Z'))).toBe(false) // inside the week
    expect(until(at('2026-08-15T22:00:00Z'))).toBe(true)  // past it
  })

  it('does not walk ground a previous run covered', () => {
    const until = recentBans({ sinceDays: 7, processedThrough: new Date('2026-08-20T00:00:00Z') })
    expect(until(at('2026-08-22T23:00:00Z'))).toBe(false)
    expect(until(at('2026-08-20T00:00:00Z'))).toBe(true) // reached last time
    expect(until(at('2026-08-19T00:00:00Z'))).toBe(true)
  })

  it('a record with no time neither anchors nor ends the walk', () => {
    const until = recentBans({ sinceDays: 1, processedThrough: null })
    expect(until({ messages: [], timeAdded: null })).toBe(false)
    expect(until(at('2026-08-22T23:00:00Z'))).toBe(false) // this one anchors
    expect(until(at('2026-08-21T22:00:00Z'))).toBe(true)
  })
})
