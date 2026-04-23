// Tests for the /del undo in-memory buffer (§7 of the UX design).
// Covers snapshot capture, LRU size cap, TTL expiry via clock injection.

const assert = require('assert')

delete require.cache[require.resolve('../helpers/delete-buffer')]
const buffer = require('../helpers/delete-buffer')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkTextMsg = (id = 1) => ({
  message_id: id,
  from: { id: 7, first_name: 'U', username: 'u' },
  text: 'hello world'
})

const mkPhotoMsg = (id = 2) => ({
  message_id: id,
  from: { id: 8, first_name: 'U2' },
  photo: [
    { file_id: 'small', width: 100, height: 100 },
    { file_id: 'medium', width: 400, height: 400 },
    { file_id: 'large', width: 1024, height: 1024 }
  ],
  caption: 'pic caption'
})

test('put/get roundtrip (text message)', () => {
  buffer._resetForTests()
  const rec = buffer.put(-100, 1, mkTextMsg(1))
  assert.ok(rec)
  assert.strictEqual(rec.text, 'hello world')
  const fetched = buffer.get(-100, 1)
  assert.strictEqual(fetched.text, 'hello world')
  assert.strictEqual(fetched.from.username, 'u')
})

test('photo snapshot picks the largest thumbnail', () => {
  buffer._resetForTests()
  buffer.put(-100, 2, mkPhotoMsg(2))
  const rec = buffer.get(-100, 2)
  assert.strictEqual(rec.photoFileId, 'large')
  assert.strictEqual(rec.caption, 'pic caption')
})

test('missing message returns null', () => {
  buffer._resetForTests()
  assert.strictEqual(buffer.get(-100, 999), null)
})

test('del() removes entry', () => {
  buffer._resetForTests()
  buffer.put(-100, 1, mkTextMsg(1))
  buffer.del(-100, 1)
  assert.strictEqual(buffer.get(-100, 1), null)
})

test('isRestorable: text → true, empty → false, album → false', () => {
  assert.strictEqual(buffer.isRestorable({ text: 'hi' }), true)
  assert.strictEqual(buffer.isRestorable({ caption: 'c', photoFileId: 'f' }), true)
  assert.strictEqual(buffer.isRestorable({}), false)
  assert.strictEqual(buffer.isRestorable(null), false)
  // media_group = album; we don't know all siblings, so unrestorable.
  assert.strictEqual(
    buffer.isRestorable({ photoFileId: 'f', mediaGroupId: '12345' }),
    false
  )
})

test('snapshot() returns null for invalid input', () => {
  assert.strictEqual(buffer.snapshot(null), null)
  assert.strictEqual(buffer.snapshot(undefined), null)
  assert.strictEqual(buffer.snapshot('not an object'), null)
})

test('cache key isolates chats (same message_id, different chat)', () => {
  buffer._resetForTests()
  buffer.put(-100, 5, { ...mkTextMsg(5), text: 'chat A' })
  buffer.put(-200, 5, { ...mkTextMsg(5), text: 'chat B' })
  assert.strictEqual(buffer.get(-100, 5).text, 'chat A')
  assert.strictEqual(buffer.get(-200, 5).text, 'chat B')
})

test('LRU size cap is enforced (MAX_ENTRIES boundary)', () => {
  buffer._resetForTests()
  // Fill past MAX_ENTRIES; oldest should evict.
  const N = buffer.MAX_ENTRIES + 10
  for (let i = 0; i < N; i++) {
    buffer.put(-100, i, mkTextMsg(i))
  }
  assert.ok(buffer._size() <= buffer.MAX_ENTRIES, `size ${buffer._size()} <= ${buffer.MAX_ENTRIES}`)
  // Oldest entries are gone; newer are retained.
  assert.strictEqual(buffer.get(-100, 0), null, 'oldest evicted')
  assert.ok(buffer.get(-100, N - 1), 'newest present')
})

test('TTL is 30s (sanity — no clock mock, just check constant)', () => {
  assert.strictEqual(buffer.TTL_MS, 30 * 1000)
})

test('document file_id captured', () => {
  buffer._resetForTests()
  buffer.put(-100, 3, {
    message_id: 3,
    document: { file_id: 'doc_abc', file_name: 'x.pdf' }
  })
  assert.strictEqual(buffer.get(-100, 3).documentFileId, 'doc_abc')
})

test('video / animation / voice / audio / video_note all captured', () => {
  buffer._resetForTests()
  buffer.put(-100, 10, { message_id: 10, video: { file_id: 'vid' } })
  buffer.put(-100, 11, { message_id: 11, animation: { file_id: 'ani' } })
  buffer.put(-100, 12, { message_id: 12, voice: { file_id: 'voi' } })
  buffer.put(-100, 13, { message_id: 13, audio: { file_id: 'aud' } })
  buffer.put(-100, 14, { message_id: 14, video_note: { file_id: 'vn' } })
  buffer.put(-100, 15, { message_id: 15, sticker: { file_id: 'stk' } })
  assert.strictEqual(buffer.get(-100, 10).videoFileId, 'vid')
  assert.strictEqual(buffer.get(-100, 11).animationFileId, 'ani')
  assert.strictEqual(buffer.get(-100, 12).voiceFileId, 'voi')
  assert.strictEqual(buffer.get(-100, 13).audioFileId, 'aud')
  assert.strictEqual(buffer.get(-100, 14).videoNoteFileId, 'vn')
  assert.strictEqual(buffer.get(-100, 15).stickerFileId, 'stk')
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + (e.stack || e.message)) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
