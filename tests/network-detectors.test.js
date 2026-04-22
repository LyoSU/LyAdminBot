const assert = require('assert')
const {
  recordCustomEmojiUse,
  queryEmojiCluster,
  recordChatFirstMessage,
  _resetForTests
} = require('../helpers/network-detectors')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ---------------- custom emoji cluster ----------------

test('emoji: single user+id yields no cluster', () => {
  _resetForTests()
  const r = recordCustomEmojiUse(1, ['id-a'])
  assert.deepStrictEqual(r, [])
  assert.strictEqual(queryEmojiCluster(['id-a']).clustered, false)
})

test('emoji: 3 users sharing an id → cluster', () => {
  _resetForTests()
  recordCustomEmojiUse(1, ['id-a'])
  recordCustomEmojiUse(2, ['id-a'])
  const r = recordCustomEmojiUse(3, ['id-a'])
  assert.ok(r.length >= 1)
  assert.strictEqual(r[0].id, 'id-a')
  assert.strictEqual(queryEmojiCluster(['id-a']).clustered, true)
})

test('emoji: same user repeatedly does NOT count as cluster', () => {
  _resetForTests()
  recordCustomEmojiUse(1, ['id-x'])
  recordCustomEmojiUse(1, ['id-x'])
  recordCustomEmojiUse(1, ['id-x'])
  assert.strictEqual(queryEmojiCluster(['id-x']).clustered, false)
})

test('emoji: queryEmojiCluster on unknown id returns clustered=false', () => {
  _resetForTests()
  assert.strictEqual(queryEmojiCluster(['never-seen']).clustered, false)
})

// ---------------- chat-level first-message burst ----------------

test('burst: single first-message returns null', () => {
  _resetForTests()
  const r = recordChatFirstMessage(-100, 1, 'Hello everyone, joining this chat today')
  assert.strictEqual(r, null)
})

test('burst: 3 new users with similar text → burst descriptor', () => {
  _resetForTests()
  // Template with a single token swapped — real coordinated-spam pattern.
  // All three hashes stay within the Hamming threshold of each other.
  const text1 = 'Earn daily crypto signals visit our telegram channel now tomorrow forever and always'
  const text2 = 'Earn daily crypto signals visit our telegram channel today tomorrow forever and always'
  const text3 = 'Earn daily crypto signals visit our telegram channel later tomorrow forever and always'
  recordChatFirstMessage(-100, 1, text1)
  recordChatFirstMessage(-100, 2, text2)
  const r = recordChatFirstMessage(-100, 3, text3)
  assert.ok(r, 'expected burst descriptor')
  assert.ok(r.burstSize >= 3, `burstSize ${r.burstSize}`)
})

test('burst: 3 new users with DIFFERENT text → no burst', () => {
  _resetForTests()
  recordChatFirstMessage(-101, 11, 'Hi everyone, how are you today people')
  recordChatFirstMessage(-101, 12, 'Can anyone help me find the documentation')
  const r = recordChatFirstMessage(-101, 13, 'I love kittens and pizza and long walks')
  assert.strictEqual(r, null)
})

test('burst: 3 users media-only first-messages → burst (same "media" cluster)', () => {
  _resetForTests()
  recordChatFirstMessage(-102, 21, null)
  recordChatFirstMessage(-102, 22, null)
  const r = recordChatFirstMessage(-102, 23, null)
  assert.ok(r)
  assert.strictEqual(r.burstSize, 3)
})

test('burst: invalid input', () => {
  assert.strictEqual(recordChatFirstMessage(null, 1, 'x'), null)
  assert.strictEqual(recordChatFirstMessage(-100, null, 'x'), null)
})

let passed = 0; let failed = 0
for (const t of tests) {
  try { t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
