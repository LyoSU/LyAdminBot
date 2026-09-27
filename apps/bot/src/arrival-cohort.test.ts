import { describe, expect, it } from 'vitest'
import {
  arrivalShapeOf, cohortSiblings, recordBanTargets, sameShape, type CohortArrival, type JoinerFacts
} from './arrival-cohort.js'
import type { ArrivalShape } from '@lyadmin/data'

const joiner = (over: Partial<JoinerFacts> = {}): JoinerFacts => ({
  id: 8_500_000_000,
  displayName: 'Орислава Басюк',
  username: null,
  lastName: 'Басюк',
  hasPhoto: false,
  isPremium: false,
  ...over
})

describe('arrivalShapeOf', () => {
  it('records facts about the account, never the name', () => {
    const shape = arrivalShapeOf(joiner())
    expect(shape).toMatchObject({ username: false, photo: false, lastName: true, premium: false, script: 'cyrillic' })
    expect(JSON.stringify(shape)).not.toContain('Орислава')
  })

  it('reads an empty handle or a blank last name as absent', () => {
    const shape = arrivalShapeOf(joiner({ username: '', lastName: '  ' }))
    expect(shape.username).toBe(false)
    expect(shape.lastName).toBe(false)
  })

  it('names no script for a name whose letters do not agree, or that has none', () => {
    expect(arrivalShapeOf(joiner({ displayName: '🌸🌸' })).script).toBeNull()
  })

  it('predicts a registration for an ordinary id and none for an unusable one', () => {
    expect(arrivalShapeOf(joiner()).registeredUnix).toEqual(expect.any(Number))
    expect(arrivalShapeOf(joiner({ id: -5 })).registeredUnix).toBeNull()
  })
})

describe('recordBanTargets', () => {
  const at = (min: number): Date => new Date(Date.UTC(2026, 8, 27, 10, min))

  it('names every other chat the account joined, newest first', () => {
    expect(recordBanTargets([
      { chatId: -1, at: at(1), outcome: null },
      { chatId: -2, at: at(5), outcome: null },
      { chatId: -3, at: at(3), outcome: null }
    ], -1)).toEqual([-2, -3])
  })

  it('skips a chat the account was already taken from, but not one merely annotated', () => {
    expect(recordBanTargets([
      { chatId: -2, at: at(5), outcome: 'removed' },
      { chatId: -3, at: at(4), outcome: 'banned_on_record' },
      { chatId: -4, at: at(3), outcome: 'listed_clean' }
    ], -1)).toEqual([-4])
  })

  it('stops at the cap', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ chatId: -100 - i, at: at(i), outcome: null }))
    expect(recordBanTargets(rows, -1, 10)).toHaveLength(10)
  })

  it('names nothing for an account seen only where it was removed', () => {
    expect(recordBanTargets([{ chatId: -1, at: at(1), outcome: null }], -1)).toEqual([])
  })
})

describe('sameShape', () => {
  const base: ArrivalShape = {
    username: false, photo: false, lastName: true, premium: false, script: 'cyrillic', registeredUnix: 1_780_000_000
  }

  it('matches one batch: every fact equal, registered within the tolerance', () => {
    expect(sameShape(base, { ...base, registeredUnix: base.registeredUnix! + 30 * 86400 })).toBe(true)
  })

  it('refuses when any free fact differs', () => {
    for (const key of ['username', 'photo', 'lastName', 'premium'] as const) {
      expect(sameShape(base, { ...base, [key]: !base[key] })).toBe(false)
    }
    expect(sameShape(base, { ...base, script: 'latin' })).toBe(false)
    expect(sameShape(base, { ...base, registeredUnix: base.registeredUnix! + 90 * 86400 })).toBe(false)
  })

  it('does not treat two missing facts as agreement', () => {
    expect(sameShape({ ...base, script: null }, { ...base, script: null })).toBe(false)
    expect(sameShape({ ...base, registeredUnix: null }, { ...base, registeredUnix: null })).toBe(false)
  })
})

describe('cohortSiblings', () => {
  const shape: ArrivalShape = {
    username: false, photo: false, lastName: true, premium: false, script: 'cyrillic', registeredUnix: 1_780_000_000
  }
  const hour = 60 * 60 * 1000
  const t0 = Date.UTC(2026, 8, 27, 12)
  const arrival = (userId: number, hoursFromSpammer: number, over: Partial<CohortArrival> = {}): CohortArrival => ({
    userId, at: new Date(t0 + hoursFromSpammer * hour), shape, messagesGlobalAtJoin: null, outcome: null, ...over
  })
  const spammer = arrival(1, 0)

  it('names the look-alike newcomers around the spammer, nearest first', () => {
    const rows = [spammer, arrival(2, -30), arrival(3, 5), arrival(4, 71)]
    expect(cohortSiblings(spammer, rows).map((a) => a.userId)).toEqual([3, 2, 4])
  })

  it('leaves out the spammer, the too-distant, the different, the known and the already removed', () => {
    const rows = [
      spammer,
      arrival(2, 73),
      arrival(3, 1, { shape: { ...shape, username: true } }),
      arrival(4, 1, { messagesGlobalAtJoin: 12 }),
      arrival(5, 1, { outcome: 'banned_on_record' }),
      arrival(6, 1, { outcome: 'gated' })
    ]
    expect(cohortSiblings(spammer, rows).map((a) => a.userId)).toEqual([6])
  })

  it('caps the card', () => {
    const rows = Array.from({ length: 25 }, (_, i) => arrival(100 + i, i))
    expect(cohortSiblings(spammer, rows, { max: 10 })).toHaveLength(10)
  })

  // A chat's ordinary newcomers vary; a batch does not. Whatever the rows,
  // every sibling must share the spammer's shape and window.
  it('never names somebody unlike the spammer', () => {
    const scripts = ['cyrillic', 'latin', null]
    const rows: CohortArrival[] = []
    for (let i = 0; i < 200; i++) {
      rows.push(arrival(10 + i, ((i * 37) % 200) - 100, {
        shape: {
          username: i % 2 === 0, photo: i % 3 === 0, lastName: i % 5 !== 0, premium: i % 7 === 0,
          script: scripts[i % 3]!, registeredUnix: i % 11 === 0 ? null : 1_780_000_000 + ((i * 13) % 120) * 86400
        },
        messagesGlobalAtJoin: i % 4 === 0 ? 3 : null
      }))
    }
    for (const s of cohortSiblings(spammer, rows, { max: 200 })) {
      expect(sameShape(s.shape, shape)).toBe(true)
      expect(Math.abs(s.at.getTime() - t0)).toBeLessThanOrEqual(72 * hour)
      expect(s.messagesGlobalAtJoin ?? 0).toBe(0)
    }
  })
})
