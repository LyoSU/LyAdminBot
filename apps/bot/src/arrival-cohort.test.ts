import { describe, expect, it } from 'vitest'
import { arrivalShapeOf, recordBanTargets, type JoinerFacts } from './arrival-cohort.js'

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
