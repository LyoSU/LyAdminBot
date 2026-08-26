import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { computeForwardHash, forwardStatusFor } from './forward-port.js'

const v1Hash = (type: string, identifier: string): string =>
  createHash('sha256').update(`${type}:${identifier}`).digest('hex').substring(0, 16)

describe('computeForwardHash (byte-compatible with v1 getForwardHash)', () => {
  it('hashes user/chat/channel by numeric id', () => {
    expect(computeForwardHash({ kind: 'user', title: 'Іван', sourceId: 123 }))
      .toEqual({ type: 'user', hash: v1Hash('user', '123'), identifier: '123' })
    expect(computeForwardHash({ kind: 'channel', title: 'News', sourceId: -100555 }))
      .toEqual({ type: 'channel', hash: v1Hash('channel', '-100555'), identifier: '-100555' })
    expect(computeForwardHash({ kind: 'chat', title: 'Chat', sourceId: -42 })?.type).toBe('chat')
  })

  it('hashes hidden users by display name (v1 fallback included)', () => {
    expect(computeForwardHash({ kind: 'hidden_user', title: 'Vasya', sourceId: null }))
      .toEqual({ type: 'hidden', hash: v1Hash('hidden', 'Vasya'), identifier: 'Vasya' })
    expect(computeForwardHash({ kind: 'hidden_user', title: null, sourceId: null }))
      .toEqual({ type: 'hidden', hash: v1Hash('hidden', 'unknown_hidden'), identifier: 'unknown_hidden' })
  })

  it('returns null when a visible source has no id', () => {
    expect(computeForwardHash({ kind: 'user', title: 'X', sourceId: null })).toBeNull()
    expect(computeForwardHash({ kind: 'channel', title: 'X' })).toBeNull()
  })
})

describe('forwardStatusFor (v1 thresholds, clean counter-reports 2:1)', () => {
  /** Two chats, so the blacklist tier is reachable and the thresholds are what is tested. */
  const spread = 2

  it('hidden sources blacklist faster than user sources', () => {
    expect(forwardStatusFor('hidden', 3, 0, spread)).toBe('suspicious')
    expect(forwardStatusFor('hidden', 6, 0, spread)).toBe('blacklisted')
    expect(forwardStatusFor('user', 6, 0, spread)).toBe('clean')
    expect(forwardStatusFor('user', 8, 0, spread)).toBe('suspicious')
    expect(forwardStatusFor('user', 15, 0, spread)).toBe('blacklisted')
  })

  it('clean reports counteract spam reports at 2:1', () => {
    expect(forwardStatusFor('hidden', 6, 0, spread)).toBe('blacklisted')
    expect(forwardStatusFor('hidden', 6, 2, spread)).toBe('suspicious')
    expect(forwardStatusFor('hidden', 6, 8, spread)).toBe('clean')
  })

  it('unknown types fall back to the strictest user thresholds', () => {
    expect(forwardStatusFor('nonsense', 14, 0, spread)).toBe('suspicious')
  })

  /**
   * A blacklist is enforced in every chat for 180 days, and one room — however
   * loud — is not the network agreeing. Production 2026-08-26 held a channel
   * blacklisted on 48 reports that all came from one chat.
   */
  it('one chat alone cannot blacklist a source anywhere', () => {
    expect(forwardStatusFor('hidden', 48, 0, 1)).toBe('suspicious')
    expect(forwardStatusFor('hidden', 48, 0, 2)).toBe('blacklisted')
  })

  it('suspicious still needs only one chat — it weighs, it does not convict', () => {
    expect(forwardStatusFor('hidden', 3, 0, 1)).toBe('suspicious')
  })

  /**
   * Records written before the set was read say nothing about spread, and the
   * conservative reading of silence is "we do not know" — one more report from
   * one more chat restores what a single chat's word used to buy.
   */
  it('a record that names no chats cannot reach the blacklist', () => {
    expect(forwardStatusFor('hidden', 100, 0)).toBe('suspicious')
  })
})
