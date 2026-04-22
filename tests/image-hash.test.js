const assert = require('assert')
const { dhash, hammingDistance, isNearDuplicate } = require('../helpers/image-hash')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// Lazy-require sharp so the test file can be parsed on systems without it.
const sharp = require('sharp')

/**
 * Build a tiny monochrome test image programmatically using sharp.
 * Returns a PNG buffer.
 */
const makeImage = async (pixels, width = 8, height = 8) => {
  // `pixels` is an array of RGB triples OR a flat raw array.
  const raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    const [r, g, b] = pixels[i] || [0, 0, 0]
    raw[i * 3] = r
    raw[i * 3 + 1] = g
    raw[i * 3 + 2] = b
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

test('dhash: 16-hex-char output on valid image', async () => {
  const buf = await makeImage(Array.from({ length: 64 }, (_, i) => [i * 4, i * 4, i * 4]))
  const h = await dhash(buf)
  assert.ok(h)
  assert.strictEqual(h.length, 16)
  assert.match(h, /^[0-9a-f]{16}$/)
})

test('dhash: same image → same hash', async () => {
  const pixels = Array.from({ length: 64 }, (_, i) => [(i * 3) % 255, (i * 7) % 255, (i * 5) % 255])
  const buf1 = await makeImage(pixels)
  const buf2 = await makeImage(pixels)
  const h1 = await dhash(buf1)
  const h2 = await dhash(buf2)
  assert.strictEqual(h1, h2)
})

test('dhash: slight variation → small Hamming distance', async () => {
  const base = Array.from({ length: 64 }, (_, i) => [i * 4, i * 4, i * 4])
  const perturb = base.map((p, i) => i === 30 ? [p[0] + 5, p[1] + 5, p[2] + 5] : p)
  const h1 = await dhash(await makeImage(base))
  const h2 = await dhash(await makeImage(perturb))
  const d = hammingDistance(h1, h2)
  assert.ok(d <= 4, `expected small distance, got ${d}`)
})

test('dhash: invalid buffer returns null', async () => {
  assert.strictEqual(await dhash(Buffer.from('not an image')), null)
  assert.strictEqual(await dhash(null), null)
})

test('hammingDistance: identical hashes = 0', () => {
  assert.strictEqual(hammingDistance('abcdef0123456789', 'abcdef0123456789'), 0)
})

test('hammingDistance: length mismatch → -1', () => {
  assert.strictEqual(hammingDistance('abc', 'abcd'), -1)
})

test('isNearDuplicate: inside default threshold', () => {
  // Two hashes differing by a couple of bits
  assert.strictEqual(isNearDuplicate('0000000000000000', '0000000000000001'), true)
})

test('isNearDuplicate: outside threshold → false', () => {
  assert.strictEqual(isNearDuplicate('0000000000000000', 'ffffffffffffffff'), false)
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
