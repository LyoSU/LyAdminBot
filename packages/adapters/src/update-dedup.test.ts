import { describe, expect, it } from 'vitest'
import { createUpdateDedup, deliveryKey } from './update-dedup.js'

const at = (t: { ms: number }, maxEntries = 1000, ttlMs = 60_000) =>
  createUpdateDedup({ maxEntries, ttlMs, now: () => t.ms })

describe('createUpdateDedup', () => {
  it('lets the first delivery through and refuses the redelivery', () => {
    const t = { ms: 1_000 }
    const dedup = at(t)
    const key = deliveryKey(-100, 42, false, null)
    expect(dedup.claim(key)).toBe(true)
    t.ms += 110
    expect(dedup.claim(key)).toBe(false)
  })

  it('collapses the production burst: three deliveries 110ms apart run once', () => {
    // 2026-08-21: one joiner greeted three times per burst, ~110 ms apart,
    // four bursts over seven minutes, ending in a getUserPhotos flood wait.
    const t = { ms: 1_000 }
    const dedup = at(t)
    const key = deliveryKey(-100, 7, false, null)
    let handled = 0
    for (let i = 0; i < 3; i += 1) {
      if (dedup.claim(key)) handled += 1
      t.ms += 110
    }
    expect(handled).toBe(1)
  })

  it('still delivers an edit of a message whose original was already handled', () => {
    // The edit path is a separate real event about the same id. Dropping it
    // because the original was seen would silence edit-injected promo.
    const t = { ms: 1_000 }
    const dedup = at(t)
    expect(dedup.claim(deliveryKey(-100, 42, false, null))).toBe(true)
    expect(dedup.claim(deliveryKey(-100, 42, true, new Date(t.ms)))).toBe(true)
  })

  it('separates successive edits but collapses one edit redelivered', () => {
    const t = { ms: 1_000 }
    const dedup = at(t)
    const first = deliveryKey(-100, 42, true, new Date(1_000))
    const second = deliveryKey(-100, 42, true, new Date(2_000))
    expect(dedup.claim(first)).toBe(true)
    expect(dedup.claim(first)).toBe(false)
    expect(dedup.claim(second)).toBe(true)
  })

  it('REGRESSION: a recovered copy that has since been edited is still a duplicate arrival', () => {
    // Gap recovery hands back the message as it stands NOW, edit date included.
    // Versioning the arrival key by editDate would make that copy look like a
    // fresh arrival and defeat the guard for exactly the messages most worth
    // deduplicating — the ones a spammer edited after posting.
    const t = { ms: 1_000 }
    const dedup = at(t)
    expect(dedup.claim(deliveryKey(-100, 42, false, null))).toBe(true)
    expect(dedup.claim(deliveryKey(-100, 42, false, new Date(5_000)))).toBe(false)
  })

  it('keeps chats apart — the same message id in two chats is two deliveries', () => {
    const t = { ms: 1_000 }
    const dedup = at(t)
    expect(dedup.claim(deliveryKey(-100, 42, false, null))).toBe(true)
    expect(dedup.claim(deliveryKey(-200, 42, false, null))).toBe(true)
  })

  it('forgets a delivery once the ttl passes', () => {
    const t = { ms: 1_000 }
    const dedup = at(t, 1000, 60_000)
    const key = deliveryKey(-100, 42, false, null)
    expect(dedup.claim(key)).toBe(true)
    t.ms += 60_001
    expect(dedup.claim(key)).toBe(true)
    expect(dedup.size()).toBe(1)
  })

  it('stays bounded under a wave and evicts the oldest delivery first', () => {
    const t = { ms: 1_000 }
    const dedup = at(t, 3)
    for (let id = 1; id <= 5; id += 1) {
      expect(dedup.claim(deliveryKey(-100, id, false, null))).toBe(true)
    }
    expect(dedup.size()).toBe(3)
    // 1 and 2 were evicted, so they read as new again; 5 is still remembered.
    expect(dedup.claim(deliveryKey(-100, 1, false, null))).toBe(true)
    expect(dedup.claim(deliveryKey(-100, 5, false, null))).toBe(false)
  })
})
