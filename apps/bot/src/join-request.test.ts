import { describe, expect, it } from 'vitest'
import {
  JOIN_REQUEST_DEDUP_MS, JOIN_REQUEST_STAMP_MS, JoinRequestLedger, createScreenLimiter
} from './join-request.js'

const clock = (start = 0) => {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}
const stamp = (at: number) => ({ wouldDecide: 'decline', reason: 'external_listing', at: new Date(at) })

describe('JoinRequestLedger', () => {
  it('records one request per chat and account per hour', () => {
    const c = clock()
    const ledger = new JoinRequestLedger(c.now)
    expect(ledger.claim(-100, 7)).toBe(true)
    expect(ledger.claim(-100, 7)).toBe(false)
    c.advance(JOIN_REQUEST_DEDUP_MS - 1)
    expect(ledger.claim(-100, 7)).toBe(false)
    c.advance(1)
    expect(ledger.claim(-100, 7)).toBe(true)
  })

  it('keeps chats and accounts apart', () => {
    const ledger = new JoinRequestLedger(clock().now)
    expect(ledger.claim(-100, 7)).toBe(true)
    expect(ledger.claim(-200, 7)).toBe(true)
    expect(ledger.claim(-100, 8)).toBe(true)
  })

  it('stays bounded under a raid, forgetting the oldest first', () => {
    const ledger = new JoinRequestLedger(clock().now, { maxTracked: 3 })
    for (const id of [1, 2, 3, 4]) ledger.claim(-100, id)
    expect(ledger.size).toBe(3)
    expect(ledger.claim(-100, 1)).toBe(true)
    expect(ledger.claim(-100, 4)).toBe(false)
  })

  it('hands the answer to the arrival once, and not a stale one', () => {
    const c = clock()
    const ledger = new JoinRequestLedger(c.now)
    ledger.claim(-100, 7)
    ledger.remember(-100, 7, stamp(0))
    expect(ledger.take(-100, 7)).toEqual(stamp(0))
    expect(ledger.take(-100, 7)).toBeNull()

    ledger.claim(-100, 8)
    ledger.remember(-100, 8, stamp(0))
    c.advance(JOIN_REQUEST_STAMP_MS + 1)
    expect(ledger.take(-100, 8)).toBeNull()
  })

  it('an arrival nobody requested has nothing to take', () => {
    const ledger = new JoinRequestLedger(clock().now)
    expect(ledger.take(-100, 7)).toBeNull()
    ledger.claim(-100, 7)
    expect(ledger.take(-100, 7)).toBeNull()
  })
})

describe('createScreenLimiter', () => {
  const gate = () => {
    let open!: () => void
    const p = new Promise<void>((r) => { open = r })
    return { p, open }
  }

  it('runs at most `concurrency` at once and refuses past the queue', async () => {
    const limiter = createScreenLimiter({ concurrency: 2, maxQueued: 1 })
    const gates = [gate(), gate(), gate()]
    let started = 0
    const runs = gates.map((g) => limiter.submit(async () => { started += 1; await g.p; return started }))
    expect(runs.every((r) => r !== null)).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(limiter.active).toBe(2)
    expect(limiter.queued).toBe(1)
    expect(limiter.submit(async () => 0)).toBeNull()

    gates[0]!.open()
    await runs[0]
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toBe(3)
    gates[1]!.open(); gates[2]!.open()
    await Promise.all(runs)
    expect(limiter.active).toBe(0)
  })

  it('a failing or throwing task frees its slot', async () => {
    const limiter = createScreenLimiter({ concurrency: 1, maxQueued: 0 })
    await expect(limiter.submit(() => { throw new Error('sync') })).rejects.toThrow('sync')
    await expect(limiter.submit(async () => { throw new Error('async') })).rejects.toThrow('async')
    expect(limiter.active).toBe(0)
    await expect(limiter.submit(async () => 5)).resolves.toBe(5)
  })
})
