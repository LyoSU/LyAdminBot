import { describe, expect, it } from 'vitest'
import { arrivalShapeOf, type JoinerFacts } from './arrival-cohort.js'

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
