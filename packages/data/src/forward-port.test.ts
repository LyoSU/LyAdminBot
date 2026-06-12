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
  it('hidden sources blacklist faster than user sources', () => {
    expect(forwardStatusFor('hidden', 3, 0)).toBe('suspicious')
    expect(forwardStatusFor('hidden', 6, 0)).toBe('blacklisted')
    expect(forwardStatusFor('user', 6, 0)).toBe('clean')
    expect(forwardStatusFor('user', 8, 0)).toBe('suspicious')
    expect(forwardStatusFor('user', 15, 0)).toBe('blacklisted')
  })

  it('clean reports counteract spam reports at 2:1', () => {
    expect(forwardStatusFor('hidden', 6, 0)).toBe('blacklisted')
    expect(forwardStatusFor('hidden', 6, 2)).toBe('suspicious')
    expect(forwardStatusFor('hidden', 6, 8)).toBe('clean')
  })

  it('unknown types fall back to the strictest user thresholds', () => {
    expect(forwardStatusFor('nonsense', 14, 0)).toBe('suspicious')
  })
})
