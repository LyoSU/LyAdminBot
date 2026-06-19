import { describe, expect, it } from 'vitest'
import {
  parseLolsResponse,
  parseCasResponse,
  needsExternalRecheck,
  isQueryableUserId,
  fetchExternalBan,
  EXTERNAL_BAN_TTL_MS
} from './external-ban.js'

/** A fetch stub routing by host to a canned JSON body (or an Error to throw). */
const stubFetch = (byHost: Record<string, unknown | Error>) =>
  async (url: string): Promise<{ json: () => Promise<unknown> }> => {
    const host = new URL(url).host
    const body = byHost[host]
    if (body instanceof Error) throw body
    return { json: async () => body }
  }

const NOW = new Date('2026-06-19T00:00:00Z')

describe('parseLolsResponse', () => {
  it('maps a banned account with its spam factor', () => {
    const rec = parseLolsResponse(
      { ok: true, banned: true, spam_factor: 0.9, scammer: false },
      NOW
    )
    expect(rec).toEqual({ banned: true, spamFactor: 0.9, scammer: false, checkedAt: NOW })
  })

  it('caches clean accounts too (negative cache), keeping spam_factor', () => {
    const rec = parseLolsResponse({ ok: true, banned: false, spam_factor: 0.2 }, NOW)
    expect(rec).toEqual({ banned: false, spamFactor: 0.2, scammer: false, checkedAt: NOW })
  })

  it('surfaces the scammer flag', () => {
    expect(parseLolsResponse({ ok: true, banned: false, scammer: true }, NOW)?.scammer).toBe(true)
  })

  it('returns null when the API reports an invalid response (ok !== true)', () => {
    expect(parseLolsResponse({ ok: false }, NOW)).toBeNull()
  })

  it('degrades to null on garbage input', () => {
    expect(parseLolsResponse(null, NOW)).toBeNull()
    expect(parseLolsResponse('boom', NOW)).toBeNull()
    expect(parseLolsResponse(42, NOW)).toBeNull()
    expect(parseLolsResponse({ ok: true, spam_factor: 'NaN' }, NOW)?.spamFactor).toBe(0)
  })
})

describe('parseCasResponse', () => {
  it('treats ok=true as banned (CAS semantics)', () => {
    const rec = parseCasResponse({ ok: true, result: { offenses: 3 } }, NOW)
    expect(rec).toEqual({ banned: true, spamFactor: 0, scammer: false, checkedAt: NOW })
  })

  it('treats ok=false as a clean negative-cache entry', () => {
    expect(parseCasResponse({ ok: false }, NOW)).toEqual({
      banned: false, spamFactor: 0, scammer: false, checkedAt: NOW
    })
  })

  it('degrades to null on garbage input', () => {
    expect(parseCasResponse(null, NOW)).toBeNull()
    expect(parseCasResponse('boom', NOW)).toBeNull()
  })
})

describe('needsExternalRecheck', () => {
  it('rechecks when there is no prior check', () => {
    expect(needsExternalRecheck(undefined, NOW.getTime())).toBe(true)
    expect(needsExternalRecheck(null, NOW.getTime())).toBe(true)
  })

  it('skips a fresh check inside the TTL window', () => {
    const fresh = new Date(NOW.getTime() - 1000)
    expect(needsExternalRecheck(fresh, NOW.getTime())).toBe(false)
  })

  it('rechecks once the TTL has elapsed', () => {
    const stale = new Date(NOW.getTime() - EXTERNAL_BAN_TTL_MS - 1)
    expect(needsExternalRecheck(stale, NOW.getTime())).toBe(true)
  })

  it('rechecks on an unparseable timestamp rather than trusting it', () => {
    expect(needsExternalRecheck('not-a-date', NOW.getTime())).toBe(true)
  })
})

describe('isQueryableUserId', () => {
  it('accepts ordinary user ids', () => {
    expect(isQueryableUserId(12345678)).toBe(true)
  })

  it('rejects Telegram system / anonymous sender ids', () => {
    expect(isQueryableUserId(777000)).toBe(false)        // Telegram service
    expect(isQueryableUserId(1087968824)).toBe(false)     // GroupAnonymousBot
    expect(isQueryableUserId(136817688)).toBe(false)      // Channel_Bot
  })

  it('rejects non-positive / non-finite ids', () => {
    expect(isQueryableUserId(0)).toBe(false)
    expect(isQueryableUserId(-1)).toBe(false)
    expect(isQueryableUserId(Number.NaN)).toBe(false)
  })
})

describe('fetchExternalBan', () => {
  it('queries both databases and merges the results', async () => {
    const fetchImpl = stubFetch({
      'api.lols.bot': { ok: true, banned: true, spam_factor: 0.95 },
      'api.cas.chat': { ok: true, result: {} }
    })
    const result = await fetchExternalBan(42, { fetchImpl, now: NOW })
    expect(result?.lols).toEqual({ banned: true, spamFactor: 0.95, scammer: false, checkedAt: NOW })
    expect(result?.cas).toEqual({ banned: true, spamFactor: 0, scammer: false, checkedAt: NOW })
  })

  it('keeps one source when the other fails (no all-or-nothing)', async () => {
    const fetchImpl = stubFetch({
      'api.lols.bot': new Error('network down'),
      'api.cas.chat': { ok: false }
    })
    const result = await fetchExternalBan(42, { fetchImpl, now: NOW })
    expect(result?.lols).toBeNull()
    expect(result?.cas).toEqual({ banned: false, spamFactor: 0, scammer: false, checkedAt: NOW })
  })

  it('never contacts a third party for a system / anonymous sender', async () => {
    let called = false
    const fetchImpl = (async () => { called = true; return { json: async () => ({}) } }) as never
    expect(await fetchExternalBan(1087968824, { fetchImpl, now: NOW })).toBeNull()
    expect(called).toBe(false)
  })
})
