import { describe, expect, it } from 'vitest'
import { formatDuration, parseBananDuration } from './duration.js'

describe('parseBananDuration', () => {
  it('parses m/h/d with minutes as the default unit', () => {
    expect(parseBananDuration('5m')).toEqual({ seconds: 300, explicit: true })
    expect(parseBananDuration('2h')).toEqual({ seconds: 7200, explicit: true })
    expect(parseBananDuration('3d')).toEqual({ seconds: 259200, explicit: true })
    expect(parseBananDuration('15')).toEqual({ seconds: 900, explicit: true })
  })

  it('clamps to [60s, 364d]', () => {
    expect(parseBananDuration('0m').seconds).toBe(60)
    expect(parseBananDuration('9999d').seconds).toBe(364 * 86400)
  })

  it('falls back to the default on garbage or absence', () => {
    expect(parseBananDuration(undefined, 600)).toEqual({ seconds: 600, explicit: false })
    expect(parseBananDuration('банан', 600)).toEqual({ seconds: 600, explicit: false })
    expect(parseBananDuration('-5m', 600)).toEqual({ seconds: 600, explicit: false })
    expect(parseBananDuration('NaNh', 600)).toEqual({ seconds: 600, explicit: false })
  })
})

describe('formatDuration', () => {
  const units = { m: 'хв', h: 'год', d: 'дн' }

  it('picks the largest sensible unit', () => {
    expect(formatDuration(300, units)).toBe('5 хв')
    expect(formatDuration(7200, units)).toBe('2 год')
    expect(formatDuration(259200, units)).toBe('3 дн')
  })

  it('rounds to a whole number of the chosen unit', () => {
    expect(formatDuration(90, units)).toBe('2 хв')
    expect(formatDuration(5400, units)).toBe('2 год')
  })
})
