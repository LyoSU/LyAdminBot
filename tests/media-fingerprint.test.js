/**
 * Media fingerprint tests.
 *
 * We test the helper (extraction + classifyVelocity pure function) without
 * spinning up MongoDB. recordAndAssess requires a DB connection and is
 * covered implicitly via the real `npm start` runtime paths.
 */

const assert = require('assert')
const { extractFingerprint } = require('../helpers/media-fingerprint')
const mediaFingerprintSchema = require('../database/models/mediaFingerprint')
const classify = mediaFingerprintSchema.statics.classifyVelocity
const THRESHOLDS = mediaFingerprintSchema.statics.VELOCITY_THRESHOLDS

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// --------------------------------------------------------------------------
// extractFingerprint — all supported media types
// --------------------------------------------------------------------------

test('extract: voice', () => {
  const r = extractFingerprint({ voice: { file_unique_id: 'abc' } })
  assert.deepStrictEqual(r, { mediaType: 'voice', fileUniqueId: 'abc' })
})

test('extract: video_note preferred over video', () => {
  const r = extractFingerprint({ video_note: { file_unique_id: 'note' }, video: { file_unique_id: 'vid' } })
  assert.strictEqual(r.mediaType, 'video_note')
})

test('extract: photo uses largest size', () => {
  const r = extractFingerprint({
    photo: [
      { file_unique_id: 'small', width: 100 },
      { file_unique_id: 'mid', width: 400 },
      { file_unique_id: 'large', width: 1280 }
    ]
  })
  assert.strictEqual(r.fileUniqueId, 'large')
  assert.strictEqual(r.mediaType, 'photo')
})

test('extract: sticker', () => {
  const r = extractFingerprint({ sticker: { file_unique_id: 'stick' } })
  assert.strictEqual(r.mediaType, 'sticker')
})

test('extract: animation', () => {
  const r = extractFingerprint({ animation: { file_unique_id: 'anim' } })
  assert.strictEqual(r.mediaType, 'animation')
})

test('extract: document', () => {
  const r = extractFingerprint({ document: { file_unique_id: 'doc' } })
  assert.strictEqual(r.mediaType, 'document')
})

test('extract: audio', () => {
  const r = extractFingerprint({ audio: { file_unique_id: 'song' } })
  assert.strictEqual(r.mediaType, 'audio')
})

test('extract: no media → null', () => {
  assert.strictEqual(extractFingerprint({ text: 'hello' }), null)
})

test('extract: null / undefined → null', () => {
  assert.strictEqual(extractFingerprint(null), null)
  assert.strictEqual(extractFingerprint(undefined), null)
})

// --------------------------------------------------------------------------
// classifyVelocity — thresholds are per-type
// --------------------------------------------------------------------------

test('classifyVelocity: voice hits 2+2 immediately', () => {
  const entry = { mediaType: 'voice', uniqueUsers: [1, 2], uniqueChats: [-1, -2] }
  const v = classify(entry)
  assert.strictEqual(v.exceeded, true)
  assert.ok(v.reason.includes('voice'))
})

test('classifyVelocity: photo needs 3 chats + 3 users', () => {
  const below = { mediaType: 'photo', uniqueUsers: [1, 2], uniqueChats: [-1, -2] }
  assert.strictEqual(classify(below).exceeded, false)
  const above = { mediaType: 'photo', uniqueUsers: [1, 2, 3], uniqueChats: [-1, -2, -3] }
  assert.strictEqual(classify(above).exceeded, true)
})

test('classifyVelocity: sticker needs 10 chats + 8 users (common reuse)', () => {
  const entry = {
    mediaType: 'sticker',
    uniqueUsers: Array.from({ length: 8 }, (_, i) => i + 1),
    uniqueChats: Array.from({ length: 10 }, (_, i) => -(i + 1))
  }
  assert.strictEqual(classify(entry).exceeded, true)
})

test('classifyVelocity: sticker below threshold is clean', () => {
  const entry = {
    mediaType: 'sticker',
    uniqueUsers: [1, 2],
    uniqueChats: [-1, -2, -3]
  }
  assert.strictEqual(classify(entry).exceeded, false)
})

test('classifyVelocity: unknown mediaType gracefully returns clean', () => {
  const v = classify({ mediaType: 'unknown-thing', uniqueUsers: [1], uniqueChats: [-1] })
  assert.strictEqual(v.exceeded, false)
})

test('classifyVelocity: null entry', () => {
  const v = classify(null)
  assert.strictEqual(v.exceeded, false)
})

test('THRESHOLDS sanity: stricter for unique-content types', () => {
  // Voice must be strictly stricter than sticker (because humans don't re-share voice).
  assert.ok(THRESHOLDS.voice.minUsers < THRESHOLDS.sticker.minUsers)
  assert.ok(THRESHOLDS.voice.minChats < THRESHOLDS.sticker.minChats)
})

// --------------------------------------------------------------------------
// Run
// --------------------------------------------------------------------------

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    t.fn()
    passed += 1
    console.log(`  ✓ ${t.name}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${t.name}`)
    console.log('     ' + err.message)
  }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
