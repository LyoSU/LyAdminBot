const assert = require('assert')
const llmCache = require('../helpers/llm-cache')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('get: miss on empty cache', () => {
  llmCache._resetForTests()
  assert.strictEqual(llmCache.get('hello world of telegram', { isNewAccount: true, isHighRisk: false }), null)
})

test('set/get round-trip with same bucket', () => {
  llmCache._resetForTests()
  const text = 'Earn daily crypto signals every morning at 9am'
  const bucket = { isNewAccount: true, isHighRisk: true }
  llmCache.set(text, bucket, { isSpam: true, confidence: 92, reason: 'promo' })
  const got = llmCache.get(text, bucket)
  assert.ok(got)
  assert.strictEqual(got.isSpam, true)
  assert.strictEqual(got.confidence, 92)
  assert.strictEqual(got.cacheHits, 1)
})

test('set/get: different bucket = miss', () => {
  llmCache._resetForTests()
  const text = 'Earn daily crypto signals every morning at 9am'
  llmCache.set(text, { isNewAccount: true, isHighRisk: true }, { isSpam: true, confidence: 92 })
  // Different bucket
  assert.strictEqual(llmCache.get(text, { isNewAccount: false, isHighRisk: false }), null)
})

test('very short text not cached', () => {
  llmCache._resetForTests()
  const bucket = { isNewAccount: true, isHighRisk: false }
  const stored = llmCache.set('tiny', bucket, { isSpam: false, confidence: 10 })
  assert.strictEqual(stored, false)
  assert.strictEqual(llmCache.get('tiny', bucket), null)
})

test('emoji-only text not cached', () => {
  llmCache._resetForTests()
  const bucket = { isNewAccount: true, isHighRisk: false }
  const stored = llmCache.set('🎉🎉🎉🎉🎉🎉🎉🎉🎉', bucket, { isSpam: false, confidence: 5 })
  assert.strictEqual(stored, false)
})

test('cacheKey is stable for same text+bucket', () => {
  const k1 = llmCache.cacheKey('Hello my friends here today', llmCache.makeBucket({ isNewAccount: true, isHighRisk: false }))
  const k2 = llmCache.cacheKey('Hello my friends here today', llmCache.makeBucket({ isNewAccount: true, isHighRisk: false }))
  assert.strictEqual(k1, k2)
})

test('cacheHits increment per lookup', () => {
  llmCache._resetForTests()
  const text = 'This message may look promotional for crypto'
  const bucket = { isNewAccount: false, isHighRisk: true }
  llmCache.set(text, bucket, { isSpam: true, confidence: 89 })
  llmCache.get(text, bucket)
  llmCache.get(text, bucket)
  const r3 = llmCache.get(text, bucket)
  assert.strictEqual(r3.cacheHits, 3)
})

// Regression: distinct Cyrillic messages must not collide to the same key.
// Before the velocity.js tokenizer fix, `\w` (ASCII-only) stripped all
// Cyrillic → zero tokens → simHash '0000000000000000' → every Ukrainian /
// Russian message hit ONE cache slot, causing a single "Uncle Sasha" verdict
// to be replayed for unrelated messages across different chats.
test('cyrillic: distinct messages produce distinct keys', () => {
  const bucket = llmCache.makeBucket({ isNewAccount: false, isHighRisk: false })
  const samples = [
    'Вітаю,які саме серветки хочете за гойдалку',
    'в таксі було так спекотно, що я розстебнулася і забула про це',
    'Кто нибудь может одолжить суперклей?',
    'Шкода,що раніше не замітила сюрприз',
    'Гагарін і вас любіла дуже сильно'
  ]
  const keys = samples.map(s => llmCache.cacheKey(s, bucket))
  assert.ok(keys.every(k => k !== null), 'all should produce a cache key')
  assert.strictEqual(new Set(keys).size, samples.length, 'keys must be distinct')
})

test('cyrillic: all-zero simhash is rejected defensively', () => {
  // Whitespace/punctuation-heavy short snippets can still collapse to
  // zero-tokens. The cache must reject that key even if length > 16.
  const bucket = llmCache.makeBucket({ isNewAccount: false, isHighRisk: false })
  const k = llmCache.cacheKey('... ... ... ... ... ... ...', bucket)
  // Either tokenize produces real tokens (unlikely for this input) or we
  // reject the zero-hash; both outcomes are acceptable — the bad state
  // would be caching under the zero-hash slot.
  if (k !== null) assert.ok(!/0{16}$/.test(k), `zero-hash leaked into key: ${k}`)
})

let passed = 0; let failed = 0
for (const t of tests) {
  try { t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
