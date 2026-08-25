import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  dhash, hammingDistance, isDegenerateHash, DHASH_MATCH_MAX_DISTANCE, type RgbaImage
} from './dhash.js'

/** Build an RGBA image from a per-pixel luma function. */
const image = (width: number, height: number, at: (x: number, y: number) => number): RgbaImage => {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.max(0, Math.min(255, Math.round(at(x, y))))
      const i = (y * width + x) * 4
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
    }
  }
  return { width, height, data }
}

/** A picture with enough structure that its hash is not degenerate. */
const photo = (w = 64, h = 64, seed = 0): RgbaImage =>
  image(w, h, (x, y) => ((x * 37 + y * 91 + seed * 13) % 251))

describe('dhash', () => {
  it('is 16 hex characters of a 64-bit hash', () => {
    const h = dhash(photo())
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })

  it('gives the same hash for the same picture', () => {
    expect(dhash(photo())).toBe(dhash(photo()))
  })

  it('gives different hashes for different pictures', () => {
    expect(dhash(photo(64, 64, 1))).not.toBe(dhash(photo(64, 64, 7)))
  })

  /**
   * The property the whole design rests on: a re-upload is a re-encode, and a
   * re-encode must not change the answer. Simulated as the two things a
   * re-encode does — a resize and a global brightness shift.
   */
  it('survives a resize', () => {
    const big = image(128, 128, (x, y) => ((x * 2 + y * 5) % 251))
    const small = image(64, 64, (x, y) => ((x * 4 + y * 10) % 251))
    const a = dhash(big)
    const b = dhash(small)
    expect(a).not.toBeNull()
    expect(hammingDistance(a!, b!)).toBeLessThanOrEqual(DHASH_MATCH_MAX_DISTANCE)
  })

  it('survives a brightness shift, because it encodes gradients', () => {
    const base = photo(64, 64, 3)
    const brighter = image(64, 64, (x, y) => ((x * 37 + y * 91 + 39) % 251) * 0.8 + 40)
    const a = dhash(base)
    const b = dhash(brighter)
    expect(hammingDistance(a!, b!)).toBeLessThanOrEqual(DHASH_MATCH_MAX_DISTANCE)
  })

  it('refuses an image smaller than the grid rather than hashing noise', () => {
    expect(dhash(image(8, 8, () => 100))).toBeNull()
    expect(dhash(image(9, 7, () => 100))).toBeNull()
  })

  it('refuses a truncated buffer instead of reading zeros past the end', () => {
    expect(dhash({ width: 64, height: 64, data: new Uint8Array(64) })).toBeNull()
  })

  it('refuses non-integer dimensions', () => {
    expect(dhash({ width: 64.5, height: 64, data: new Uint8Array(64 * 65 * 4) })).toBeNull()
  })
})

describe('hammingDistance', () => {
  it('counts differing bits', () => {
    expect(hammingDistance('0000', '0000')).toBe(0)
    expect(hammingDistance('0000', '0001')).toBe(1)
    expect(hammingDistance('0000', 'ffff')).toBe(16)
  })

  it('refuses hashes of different length rather than inventing a distance', () => {
    expect(hammingDistance('0000', '00000')).toBeNull()
  })

  it('refuses non-hex input', () => {
    expect(hammingDistance('zzzz', '0000')).toBeNull()
  })
})

/**
 * The 2026-02 lesson, applied on the way in. A normalisation that collapses
 * unrelated inputs to one value produced a store entry matching everything —
 * three times in the text layer. The image equivalent is a blank avatar.
 */
describe('isDegenerateHash', () => {
  it('rejects a solid colour', () => {
    const flat = dhash(image(64, 64, () => 128))
    expect(flat).not.toBeNull()
    expect(isDegenerateHash(flat!)).toBe(true)
  })

  it('rejects all-ones as well as all-zeros', () => {
    expect(isDegenerateHash('0000000000000000')).toBe(true)
    expect(isDegenerateHash('ffffffffffffffff')).toBe(true)
  })

  it('accepts a picture with structure', () => {
    expect(isDegenerateHash(dhash(photo())!)).toBe(false)
  })

  /**
   * A horizontal gradient is the case that motivates the check: every row is
   * monotonic, so every comparison answers the same way and thousands of
   * unrelated pictures land on one hash.
   */
  it('rejects a plain gradient', () => {
    const gradient = dhash(image(64, 64, (x) => x * 4))
    expect(isDegenerateHash(gradient!)).toBe(true)
  })
})

describe('dhash — properties', () => {
  const dims = fc.integer({ min: 9, max: 40 })

  it('never returns anything but 16 lowercase hex chars, or null', () => {
    fc.assert(fc.property(dims, dims, fc.integer({ min: 0, max: 255 }), (w, h, v) => {
      const out = dhash(image(w, h, (x, y) => (x * v + y) % 256))
      expect(out === null || /^[0-9a-f]{16}$/.test(out)).toBe(true)
    }), { numRuns: 120 })
  })

  it('is deterministic — the same bytes always give the same hash', () => {
    fc.assert(fc.property(dims, dims, fc.integer({ min: 1, max: 97 }), (w, h, k) => {
      const make = (): RgbaImage => image(w, h, (x, y) => (x * k + y * 7) % 256)
      expect(dhash(make())).toBe(dhash(make()))
    }), { numRuns: 120 })
  })

  /**
   * A hash is compared against every other hash in the store, so the distance
   * function must be total and symmetric on everything the hasher can emit —
   * otherwise one odd image poisons every lookup it takes part in.
   */
  it('distance is symmetric and zero only against itself', () => {
    fc.assert(fc.property(dims, dims, fc.integer({ min: 1, max: 97 }), (w, h, k) => {
      const a = dhash(image(w, h, (x, y) => (x * k + y * 7) % 256))
      const b = dhash(image(w, h, (x, y) => (x * 7 + y * k + 31) % 256))
      if (a === null || b === null) return
      expect(hammingDistance(a, b)).toBe(hammingDistance(b, a))
      expect(hammingDistance(a, a)).toBe(0)
    }), { numRuns: 120 })
  })

  it('never crashes on a buffer shorter than the dimensions claim', () => {
    fc.assert(fc.property(dims, dims, fc.nat({ max: 400 }), (w, h, len) => {
      expect(() => dhash({ width: w, height: h, data: new Uint8Array(len) })).not.toThrow()
    }), { numRuns: 120 })
  })
})
