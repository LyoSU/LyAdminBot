import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { nameShapeOf } from './name-shape.js'

describe('nameShapeOf', () => {
  it('a handle that is the name plus digits', () => {
    expect(nameShapeOf('Marta Hill', 'marta54').handle).toBe('name_digits')
    expect(nameShapeOf('Marta', 'marta822').handle).toBe('name_digits')
    // The name's first run of letters is what the handle repeats, whatever follows it.
    expect(nameShapeOf('Marta☁️Lake', 'marta463').handle).toBe('name_digits')
  })

  it('a compound name repeated whole', () => {
    const shape = nameShapeOf('NorthWing Fire', 'northwing54')
    expect(shape.handle).toBe('name_digits')
    expect(shape.camel).toBe(true)
  })

  /**
   * A person's name-plus-digits is usually a year; the template writes two or
   * three. Counted so the week can say whether that is the separator.
   */
  it('counts the digits, and only when the handle has the shape', () => {
    expect(nameShapeOf('Marta', 'marta54').digits).toBe(2)
    expect(nameShapeOf('Marta', 'marta1987').digits).toBe(4)
    expect(nameShapeOf('Marta', 'hill1987').digits).toBeNull()
  })

  it('the filler word between the name and the digits', () => {
    expect(nameShapeOf('Marta \u{1F338}Bloom', 'martauser62').handle).toBe('name_user_digits')
  })

  it('a handle somebody chose is not the shape', () => {
    expect(nameShapeOf('Marta Hill', 'marta_hill').handle).toBeNull()
    expect(nameShapeOf('Marta Hill', 'marta').handle).toBeNull()
    expect(nameShapeOf('Marta Hill', 'hill54').handle).toBeNull()
    // One digit and five are not the two-to-four the template writes.
    expect(nameShapeOf('Marta', 'marta7').handle).toBeNull()
    expect(nameShapeOf('Marta', 'marta12345').handle).toBeNull()
    // Two letters repeat by accident.
    expect(nameShapeOf('Al', 'al54').handle).toBeNull()
  })

  it('no handle, or a name with no Latin run to repeat, answers nothing', () => {
    expect(nameShapeOf('Marta', null).handle).toBeNull()
    expect(nameShapeOf('Марта', 'marta54').handle).toBeNull()
    expect(nameShapeOf('', 'marta54').handle).toBeNull()
  })

  it('camel is an inner capital in the first word only', () => {
    expect(nameShapeOf('NorthWing', null).camel).toBe(true)
    expect(nameShapeOf('North Wing', null).camel).toBe(false)
    expect(nameShapeOf('McDonald', null).camel).toBe(false) // two letters before the capital
    expect(nameShapeOf('NORTH', null).camel).toBe(false)
  })

  it('a Latin word beside a Cyrillic word', () => {
    expect(nameShapeOf('Marta Рассвет', null).mixedWords).toBe(true)
    expect(nameShapeOf('Marta Hill', null).mixedWords).toBe(false)
    expect(nameShapeOf('Марта Рассвет', null).mixedWords).toBe(false)
    // Scripts mixed INSIDE a word are a different act with its own signal.
    expect(nameShapeOf('Mаrtа', null).mixedWords).toBe(false)
  })

  it('never throws, whatever it is handed', () => {
    fc.assert(fc.property(fc.string(), fc.option(fc.string(), { nil: null }), (name, handle) => {
      const shape = nameShapeOf(name, handle)
      return typeof shape.camel === 'boolean' && typeof shape.mixedWords === 'boolean'
    }))
  })
})
