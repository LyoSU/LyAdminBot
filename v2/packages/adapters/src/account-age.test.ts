import { describe, expect, it } from 'vitest'
import { predictAccountAgeDays, predictRegistrationUnix } from './account-age.js'

const NOW = 1_781_000_000 // 2026-06-10-ish

describe('predictRegistrationUnix', () => {
  it('interpolates inside the anchor range', () => {
    // id 1000000 anchor = 1380326400 (2013)
    expect(predictRegistrationUnix(1_000_000, NOW)).toBe(1_380_326_400)
    // somewhere in 2019 territory
    const t = predictRegistrationUnix(900_000_000, NOW)!
    expect(t).toBeGreaterThan(1_540_000_000)
    expect(t).toBeLessThan(1_600_000_000)
  })

  it('returns null inside the 32→64-bit migration dead zone', () => {
    expect(predictRegistrationUnix(3_000_000_000, NOW)).toBeNull()
    expect(predictRegistrationUnix(4_999_999_999, NOW)).toBeNull()
  })

  it('returns null for invalid ids', () => {
    expect(predictRegistrationUnix(0, NOW)).toBeNull()
    expect(predictRegistrationUnix(-5, NOW)).toBeNull()
    expect(predictRegistrationUnix(Number.NaN, NOW)).toBeNull()
  })

  it('extrapolates beyond the newest anchor but never into the future', () => {
    const t = predictRegistrationUnix(9_500_000_000, NOW)!
    expect(t).toBeGreaterThan(1_771_806_478)
    expect(t).toBeLessThanOrEqual(NOW)
  })

  it('clamps pre-2013 ids to the first anchor', () => {
    expect(predictRegistrationUnix(5, NOW)).toBe(1_380_326_400)
  })
})

describe('predictAccountAgeDays', () => {
  it('an old account is thousands of days old', () => {
    expect(predictAccountAgeDays(1_000_000, NOW)!).toBeGreaterThan(4000)
  })

  it('a brand-new id is ~0 days old', () => {
    expect(predictAccountAgeDays(9_999_999_999, NOW)!).toBeLessThan(60)
  })

  it('dead-zone ids stay unknowable', () => {
    expect(predictAccountAgeDays(2_500_000_000, NOW)).toBeNull()
  })
})
