import { describe, expect, it } from 'vitest'
import { predictAccountAgeBoundsDays, predictAccountAgeDays, predictRegistrationUnix } from './account-age.js'
import { PROD_FIRST_SEEN_2026_08 } from './account-age.fixtures.js'

const NOW = 1_781_000_000 // 2026-06-10-ish
const NOW_AFTER_HARVEST = 1_786_000_000 // 2026-08-06, after every fixture timestamp

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

describe('curve honesty against production first-seen bounds', () => {
  it('never places the earliest plausible registration after the account was seen alive', () => {
    // Inside a randomized block the point mid is the window middle, so the
    // honest contract is stated through the interval: registration COULD
    // have happened no later than first-seen ⇔ (now − hi) ≤ firstSeen.
    for (const [id, firstSeen] of PROD_FIRST_SEEN_2026_08) {
      const bounds = predictAccountAgeBoundsDays(id, NOW_AFTER_HARVEST)
      expect(bounds, `id=${id}`).not.toBeNull()
      const earliestPlausible = NOW_AFTER_HARVEST - bounds!.hi * 86400
      expect(earliestPlausible, `id=${id}`).toBeLessThanOrEqual(firstSeen + 86400)
    }
  })

  it('keeps the point estimate honest where allocation was sequential (< 7e9)', () => {
    for (const [id, firstSeen] of PROD_FIRST_SEEN_2026_08) {
      if (id >= 7_000_000_000) continue
      expect(predictRegistrationUnix(id, NOW_AFTER_HARVEST)!, `id=${id}`).toBeLessThanOrEqual(firstSeen)
    }
  })

  it('a later id never predicts an earlier registration', () => {
    let prev = -Infinity
    for (let id = 1_000_000; id < 2_147_483_648; id += 10_000_000) {
      const t = predictRegistrationUnix(id, NOW_AFTER_HARVEST)!
      expect(t, `id=${id}`).toBeGreaterThanOrEqual(prev)
      prev = t
    }
    for (let id = 5_000_000_000; id < 9_600_000_000; id += 25_000_000) {
      const t = predictRegistrationUnix(id, NOW_AFTER_HARVEST)!
      expect(t, `id=${id}`).toBeGreaterThanOrEqual(prev)
      prev = t
    }
  })

  it('places mid-2026 frontier ids in 2026, not in the audit-batch past', () => {
    const t = predictRegistrationUnix(8_995_763_329, NOW_AFTER_HARVEST)!
    expect(t).toBeGreaterThan(Date.UTC(2026, 0, 1) / 1000)
    expect(t).toBeLessThanOrEqual(NOW_AFTER_HARVEST)
  })
})

describe('randomized allocation blocks (ids >= 7e9)', () => {
  it('brackets an in-block id by the whole block window', () => {
    // Block 7.6e9..8.2e9 was active 2024-09-18 .. 2025-07-23: an id inside
    // could register at any point of the window; the interval must cover it.
    const b = predictAccountAgeBoundsDays(7_900_000_000, NOW_AFTER_HARVEST)!
    const earliest = NOW_AFTER_HARVEST - b.hi * 86400
    const latest = NOW_AFTER_HARVEST - b.lo * 86400
    expect(earliest).toBeLessThanOrEqual(Date.UTC(2024, 8, 19) / 1000)
    expect(latest).toBeGreaterThanOrEqual(Date.UTC(2025, 6, 22) / 1000)
  })

  it('cannot confirm freshness inside the active block, and cannot deny it', () => {
    // The active block 8.8e9..9e9 opened 2026-05-12: the account may be
    // today's (lo ≈ 0) or a May one (hi ≥ the window age).
    const b = predictAccountAgeBoundsDays(8_900_000_000, NOW_AFTER_HARVEST)!
    expect(b.lo).toBeLessThan(3)
    expect(b.hi).toBeGreaterThan(60)
  })

  it('an id above all known blocks appeared after the last calibration evidence', () => {
    const b = predictAccountAgeBoundsDays(9_550_000_000, NOW_AFTER_HARVEST)!
    expect(b.lo).toBeLessThan(3)
    expect(b.hi).toBeLessThan(30)
  })
})

describe('predictAccountAgeBoundsDays', () => {
  it('returns an ordered interval around the point estimate', () => {
    for (const id of [15_835_244, 900_000_000, 5_500_000_000, 8_400_000_000, 9_100_000_000]) {
      const b = predictAccountAgeBoundsDays(id, NOW_AFTER_HARVEST)!
      expect(b.lo, `id=${id}`).toBeGreaterThanOrEqual(0)
      expect(b.lo, `id=${id}`).toBeLessThanOrEqual(b.mid)
      expect(b.mid, `id=${id}`).toBeLessThanOrEqual(b.hi)
    }
  })

  it('matches the point estimate in the middle', () => {
    const b = predictAccountAgeBoundsDays(8_400_000_000, NOW_AFTER_HARVEST)!
    expect(b.mid).toBe(predictAccountAgeDays(8_400_000_000, NOW_AFTER_HARVEST))
  })

  it('keeps a brand-new frontier id certainly fresh', () => {
    // ~today's frontier: even the pessimistic bound must stay well under a year
    const b = predictAccountAgeBoundsDays(9_550_000_000, NOW_AFTER_HARVEST)!
    expect(b.lo).toBeLessThan(30)
    expect(b.hi).toBeLessThan(365)
  })

  it('stays null where the point estimate is null', () => {
    expect(predictAccountAgeBoundsDays(3_000_000_000, NOW_AFTER_HARVEST)).toBeNull()
    expect(predictAccountAgeBoundsDays(0, NOW_AFTER_HARVEST)).toBeNull()
    expect(predictAccountAgeBoundsDays(Number.NaN, NOW_AFTER_HARVEST)).toBeNull()
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
