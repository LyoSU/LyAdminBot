import { describe, expect, it } from 'vitest'
import { ArrivalLog, arrivalMessageIds } from './arrival-log.js'

const clock = (start = 1_000): { now: () => number; advance: (ms: number) => void } => {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('ArrivalLog', () => {
  it('returns the service message a join left behind', () => {
    const log = new ArrivalLog()
    log.noteJoin(-100, [7], 41)
    expect(log.take(-100, 7)).toEqual({
      serviceMessageId: 41, greetingMessageIds: [], subjects: 1
    })
  })

  it('attaches the greeting to the join already noted', () => {
    const log = new ArrivalLog()
    log.noteJoin(-100, [7], 41)
    log.noteGreeting(-100, [7], [42, 43])
    expect(log.take(-100, 7)).toEqual({
      serviceMessageId: 41, greetingMessageIds: [42, 43], subjects: 1
    })
  })

  it('keeps a greeting retractable even if the join was never noted', () => {
    // Restart between the join and the greeting, or a join we did not see.
    const log = new ArrivalLog()
    log.noteGreeting(-100, [7], [42])
    expect(log.take(-100, 7)).toEqual({
      serviceMessageId: null, greetingMessageIds: [42], subjects: 1
    })
  })

  it('does not restart the clock when the greeting arrives', () => {
    const c = clock()
    const log = new ArrivalLog(c.now, { ttlMs: 1_000 })
    log.noteJoin(-100, [7], 41)
    c.advance(900)
    log.noteGreeting(-100, [7], [42])
    c.advance(200)
    expect(log.take(-100, 7)).toBeNull()
  })

  it('reports how many people a bulk arrival named', () => {
    const log = new ArrivalLog()
    log.noteJoin(-100, [7, 8, 9], 41)
    expect(log.take(-100, 8)?.subjects).toBe(3)
  })

  it('forgets the arrival for everyone it named, not just the taker', () => {
    // One service line: taking it for the spammer must not leave the other two
    // holding a live reference to a message that is already gone.
    const log = new ArrivalLog()
    log.noteJoin(-100, [7, 8, 9], 41)
    log.noteGreeting(-100, [7, 8, 9], [42])
    log.take(-100, 7)
    expect(log.take(-100, 8)).toBeNull()
    expect(log.take(-100, 9)).toBeNull()
  })

  it('forgets an arrival once taken, so a refused delete is not retried', () => {
    const log = new ArrivalLog()
    log.noteJoin(-100, [7], 41)
    log.take(-100, 7)
    expect(log.take(-100, 7)).toBeNull()
  })

  it('returns null past the tidying window', () => {
    const c = clock()
    const log = new ArrivalLog(c.now, { ttlMs: 60_000 })
    log.noteJoin(-100, [7], 41)
    c.advance(60_001)
    expect(log.take(-100, 7)).toBeNull()
  })

  it('is per chat and per user', () => {
    const log = new ArrivalLog()
    log.noteJoin(-100, [7], 41)
    expect(log.take(-200, 7)).toBeNull()
    expect(log.take(-100, 8)).toBeNull()
    expect(log.take(-100, 7)).not.toBeNull()
  })

  it('stores nothing when the greeting failed to send', () => {
    const log = new ArrivalLog()
    log.noteGreeting(-100, [7], [])
    expect(log.take(-100, 7)).toBeNull()
  })

  it('drops expired entries before evicting live ones when it grows', () => {
    const c = clock()
    const log = new ArrivalLog(c.now, { maxTracked: 3, ttlMs: 60_000 })
    for (const id of [1, 2, 3]) log.noteJoin(-100, [id], id)
    c.advance(60_001)
    // The three below are live; the three above are not and must go first.
    for (const id of [4, 5, 6]) log.noteJoin(-100, [id], id)
    for (const id of [4, 5, 6]) expect(log.take(-100, id)).not.toBeNull()
  })

  it('stays bounded when every arrival is still live', () => {
    const log = new ArrivalLog(Date.now, { maxTracked: 2 })
    for (const id of [1, 2, 3, 4, 5]) log.noteJoin(-100, [id], id)
    // Oldest-inserted go first; the newest survive.
    expect(log.take(-100, 1)).toBeNull()
    expect(log.take(-100, 5)).not.toBeNull()
  })
})

describe('arrivalMessageIds', () => {
  it('puts the service line first, then the greeting', () => {
    expect(arrivalMessageIds({
      serviceMessageId: 41, greetingMessageIds: [42, 43], subjects: 1
    })).toEqual([41, 42, 43])
  })

  it('omits a service line we never saw', () => {
    expect(arrivalMessageIds({
      serviceMessageId: null, greetingMessageIds: [42], subjects: 1
    })).toEqual([42])
  })
})
