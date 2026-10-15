import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  COPY_CLUSTER_MIN_AUTHORS, COPY_CLUSTER_MIN_CHARS, COPY_CLUSTER_WINDOW_MS,
  copyClusterKey, copySiblings, foldCopyText, isCopyClusterTrigger, type CopyMember
} from './copy-cluster.js'

const LONG = 'Synthetic headline about a regional event happening today'
const now = Date.parse('2026-10-15T12:00:00Z')
const ago = (h: number): Date => new Date(now - h * 3600_000)

describe('copyClusterKey', () => {
  it('folds spacing, punctuation, case, emoji and compatibility forms into one key', () => {
    const a = copyClusterKey(LONG)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(copyClusterKey(`  ${LONG.toUpperCase()}!!! 🔥`)).toBe(a)
    expect(copyClusterKey(LONG.replace(/ /g, '\n'))).toBe(a)
    // Full-width Latin is NFKC-folded to ASCII.
    expect(copyClusterKey(LONG.replace('S', 'Ｓ'))).toBe(a)
    expect(copyClusterKey(`${LONG} extra`)).not.toBe(a)
  })

  it('refuses a text under the folded floor, counting letters and digits only', () => {
    const short = 'a'.repeat(COPY_CLUSTER_MIN_CHARS - 1)
    expect(copyClusterKey(short)).toBeNull()
    expect(copyClusterKey(`${short} !!! ... 🔥🔥🔥 ---`)).toBeNull()
    expect(copyClusterKey(`${short}b`)).not.toBeNull()
    expect(copyClusterKey('')).toBeNull()
  })

  it('counts code points, so a non-Latin text is not held to a UTF-16 length', () => {
    const cyr = 'ж'.repeat(COPY_CLUSTER_MIN_CHARS)
    expect(foldCopyText(cyr)).toHaveLength(COPY_CLUSTER_MIN_CHARS)
    expect(copyClusterKey(cyr)).not.toBeNull()
    // Astral letters are two UTF-16 units each; half the floor must not pass.
    expect(copyClusterKey('𠀀'.repeat(COPY_CLUSTER_MIN_CHARS / 2))).toBeNull()
  })
})

describe('copySiblings', () => {
  const row = (hash: string, userId: number, h = 1, regular?: boolean): CopyMember =>
    ({ hash, userId, at: ago(h), ...(regular === undefined ? {} : { regular }) })

  it('carries the other authors of a cluster of three', () => {
    const out = copySiblings([row('h1', 1), row('h1', 2), row('h1', 3)], 1, now)
    expect(out).toEqual([{ hash: 'h1', size: 3, siblings: [2, 3] }])
  })

  it('needs three distinct authors — a repost by one of two is still two', () => {
    expect(copySiblings([row('h1', 1), row('h1', 2), row('h1', 2, 3)], 1, now)).toEqual([])
  })

  it('needs the confirmed account in the cluster', () => {
    expect(copySiblings([row('h1', 2), row('h1', 3), row('h1', 4)], 1, now)).toEqual([])
  })

  it('drops a copy older than the window even before the TTL sweeps it', () => {
    const stale = { hash: 'h1', userId: 3, at: new Date(now - COPY_CLUSTER_WINDOW_MS - 1) }
    expect(copySiblings([row('h1', 1), row('h1', 2), stale], 1, now)).toEqual([])
  })

  it('voids a cluster a regular also wrote', () => {
    const rows = [row('h1', 1, 1, true), row('h1', 2), row('h1', 3), row('h1', 4)]
    expect(copySiblings(rows, 1, now)).toEqual([])
  })

  it('keeps clusters apart and lists the larger first', () => {
    const rows = [
      row('h1', 1), row('h1', 2), row('h1', 3),
      row('h2', 1), row('h2', 4), row('h2', 5), row('h2', 6),
      row('h3', 1), row('h3', 7)
    ]
    expect(copySiblings(rows, 1, now)).toEqual([
      { hash: 'h2', size: 4, siblings: [4, 5, 6] },
      { hash: 'h1', size: 3, siblings: [2, 3] }
    ])
  })

  it('property: never the confirmed account, never a regular, only clusters of three or more', () => {
    const member = fc.record({
      hash: fc.constantFrom('a', 'b', 'c'),
      userId: fc.integer({ min: 1, max: 8 }),
      ageH: fc.double({ min: 0, max: 30, noNaN: true }),
      regular: fc.boolean()
    })
    fc.assert(fc.property(fc.array(member, { maxLength: 40 }), fc.integer({ min: 1, max: 8 }), (raw, confirmed) => {
      const rows: CopyMember[] = raw.map((m) => ({
        hash: m.hash, userId: m.userId, at: ago(m.ageH), ...(m.regular ? { regular: true } : {})
      }))
      const regularHashes = new Set(rows.filter((r) => r.regular === true).map((r) => r.hash))
      const regularAuthors = new Set(rows.filter((r) => r.regular === true).map((r) => r.userId))
      for (const c of copySiblings(rows, confirmed, now)) {
        expect(c.siblings).not.toContain(confirmed)
        expect(c.size).toBeGreaterThanOrEqual(COPY_CLUSTER_MIN_AUTHORS)
        expect(c.siblings.length).toBe(c.size - 1)
        expect(new Set(c.siblings).size).toBe(c.siblings.length)
        expect(regularHashes.has(c.hash)).toBe(false)
        for (const u of c.siblings) {
          // Every sibling has a live, untainted row of this very text.
          expect(rows.some((r) => r.hash === c.hash && r.userId === u
            && now - r.at.getTime() <= COPY_CLUSTER_WINDOW_MS)).toBe(true)
          // A regular's text never forms a cluster, so no regular is ever named by one.
          if (regularAuthors.has(u)) {
            expect(rows.some((r) => r.hash === c.hash && r.userId === u && r.regular === true)).toBe(false)
          }
        }
      }
    }))
  })
})

describe('isCopyClusterTrigger', () => {
  const act = { action: 'ban', applied: true, needsVote: false }
  it('is an applied ban, kick or mute', () => {
    for (const action of ['ban', 'kick', 'mute']) expect(isCopyClusterTrigger({ ...act, action })).toBe(true)
  })
  it('is never a delete, an unapplied act, or one waiting on a ballot', () => {
    expect(isCopyClusterTrigger({ ...act, action: 'delete' })).toBe(false)
    expect(isCopyClusterTrigger({ ...act, action: 'none' })).toBe(false)
    expect(isCopyClusterTrigger({ ...act, applied: false })).toBe(false)
    expect(isCopyClusterTrigger({ ...act, needsVote: true })).toBe(false)
  })
})
