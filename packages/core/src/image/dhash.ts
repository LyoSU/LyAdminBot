/**
 * Perceptual hashing of profile pictures — recognising the same photograph
 * across accounts.
 *
 * Everything else in this pipeline judges a message or infers something about an
 * account. This asks a question with a factual answer: is this the picture we
 * already saw on somebody else? A campaign hands the same photo set to twenty
 * accounts, so one matched hash across two accounts is not a resemblance, an
 * opinion or a guess — it is the same file, and it says the accounts are
 * operated together.
 *
 * That property is why this module exists rather than another weight in the
 * score. Weights are calibrated against the spam of the month and go stale;
 * "these two profiles carry one photograph" stays true whatever the spam says
 * next month. A competing bot catches this class almost entirely this way.
 *
 * dHash (difference hash), not average or DCT hash, and deliberately:
 *
 *  - It compares each pixel to its right-hand neighbour, so it encodes the
 *    GRADIENT rather than absolute brightness. Re-encoding at a different JPEG
 *    quality, a resize, or a global brightness shift — everything Telegram and
 *    a lazy re-upload do — leave the gradients intact.
 *  - It is exact arithmetic on integers, with no floating-point transform, so
 *    the same input gives the same hash on every machine and version forever. A
 *    stored hash is only useful if it is comparable to one computed years later.
 *
 * What it does NOT survive, by construction: a crop, a rotation, a mirror, or a
 * pasted overlay. That is the honest limit — this finds re-use of a file, not
 * "similar-looking people".
 */

/** Grid width: 9 columns give 8 horizontal comparisons per row. */
const GRID_W = 9
const GRID_H = 8

export interface RgbaImage {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, row-major — the shape every JPEG/PNG decoder emits. */
  data: Uint8Array | Buffer
}

/**
 * Rec. 601 luma. Integer weights summing to 1000 so the result is exact: a
 * float here would make the hash depend on the platform's rounding, and two
 * runs of the same picture could then disagree in the lowest bit.
 */
const luma = (r: number, g: number, b: number): number =>
  (r * 299 + g * 587 + b * 114) / 1000

/**
 * Box-average a source rectangle down to one cell.
 *
 * Averaging rather than sampling one pixel, because a single pixel is exactly
 * what JPEG's block artefacts corrupt — and the point of the hash is to be the
 * same after a re-encode. Every source pixel contributes to exactly one cell.
 */
const cellLuma = (
  img: RgbaImage, x0: number, y0: number, x1: number, y1: number
): number => {
  let sum = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    const row = y * img.width * 4
    for (let x = x0; x < x1; x++) {
      const i = row + x * 4
      sum += luma(img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0)
      n++
    }
  }
  return n === 0 ? 0 : sum / n
}

/**
 * 64-bit dHash as 16 lowercase hex characters, or null for an image too small
 * to say anything about.
 *
 * Null rather than a hash of a 2x2 image: a store keyed on hashes must never
 * hold an entry that matches half the internet. The floor is the grid itself —
 * below it, cells would share source pixels and the comparisons would be
 * between a pixel and itself.
 */
export const dhash = (img: RgbaImage): string | null => {
  if (!Number.isInteger(img.width) || !Number.isInteger(img.height)) return null
  if (img.width < GRID_W || img.height < GRID_H) return null
  if (img.data.length < img.width * img.height * 4) return null

  // Precompute the grid so each cell is averaged once, not twice per comparison.
  const cells: number[] = []
  for (let gy = 0; gy < GRID_H; gy++) {
    const y0 = Math.floor((gy * img.height) / GRID_H)
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * img.height) / GRID_H))
    for (let gx = 0; gx < GRID_W; gx++) {
      const x0 = Math.floor((gx * img.width) / GRID_W)
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * img.width) / GRID_W))
      cells.push(cellLuma(img, x0, y0, x1, y1))
    }
  }

  let hex = ''
  let nibble = 0
  let filled = 0
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W - 1; gx++) {
      const left = cells[gy * GRID_W + gx] ?? 0
      const right = cells[gy * GRID_W + gx + 1] ?? 0
      // Strictly greater: a flat region must produce zeros rather than depending
      // on which way `>=` happens to round two identical averages.
      nibble = (nibble << 1) | (left > right ? 1 : 0)
      if (++filled === 4) {
        hex += nibble.toString(16)
        nibble = 0
        filled = 0
      }
    }
  }
  return hex
}

/**
 * Bits that differ between two hashes, or null if they are not comparable.
 *
 * Null on a length mismatch rather than a large distance: comparing a 64-bit
 * hash to something else is a bug in the caller, and answering "very different"
 * would hide it behind a plausible number.
 */
export const hammingDistance = (a: string, b: string): number | null => {
  if (a.length !== b.length) return null
  let distance = 0
  for (let i = 0; i < a.length; i++) {
    const x = Number.parseInt(a[i] ?? '', 16)
    const y = Number.parseInt(b[i] ?? '', 16)
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null
    let diff = x ^ y
    while (diff !== 0) {
      distance += diff & 1
      diff >>= 1
    }
  }
  return distance
}

/**
 * How many bits may differ and still count as the same picture.
 *
 * Zero would mean byte-identical re-encodes only, which a single re-save
 * defeats. Anything much above this starts matching pictures that merely share
 * a layout — two selfies against a bright window — and the whole value of this
 * signal is that a match is a FACT rather than a similarity. Five bits of 64 is
 * the conventional dHash bar for "same image, different encode".
 *
 * Measured 2026-08-25 on real photographs re-encoded the way an upload
 * re-encodes them:
 *
 *   same picture, 640px vs 320px            distance 0
 *   same picture, 800px at quality 35 vs 84  distance 0
 *   same picture, 640px vs 160px            distance 1-3
 *   same picture, original vs 320px crop     distance 6  ← missed
 *   four different photographs, all pairs    distance >= 20
 *
 * So the bar holds comfortably for a resize or a quality change, and loses a
 * picture whose aspect ratio was changed. That is the right way round: a missed
 * match costs one signal, a false match accuses somebody.
 *
 * The production store deliberately matches on the hash EXACTLY rather than
 * within this distance — see `profile-media-port.ts` for why, and for what it
 * would cost in index space to do otherwise. What this constant is for is the
 * robustness test: it pins the claim that a re-encode does not move the hash
 * more than this, which is the property the exact match relies on.
 */
export const DHASH_MATCH_MAX_DISTANCE = 5

/**
 * Hashes so flat they describe "a picture", not a picture.
 *
 * A solid colour, a plain gradient or a blank avatar all collapse to all-zeros
 * or all-ones, and thousands of unrelated accounts share them. Storing one
 * would produce a store entry that matches everybody — the same defect the
 * text layer hit in 2026-02 when `normalizeHeavy` collapsed every emoji-only
 * message to the SHA-256 of the empty string, and again in 2026-08 when a
 * `""` ballot collected votes. The lesson has to be applied on the way IN.
 */
export const isDegenerateHash = (hash: string): boolean => {
  const bits = hammingDistance(hash, '0'.repeat(hash.length))
  if (bits === null) return true
  const total = hash.length * 4
  // Fewer than an eighth of the bits set either way: not enough structure for a
  // match to mean anything.
  return bits <= total / 8 || bits >= total - total / 8
}
