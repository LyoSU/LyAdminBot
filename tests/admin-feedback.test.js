const assert = require('assert')
const af = require('../helpers/admin-feedback')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('queryLastAction: null when no record', () => {
  af._resetForTests()
  assert.strictEqual(af.queryLastAction(-1, 1), null)
})

test('record → query returns stored data', () => {
  af._resetForTests()
  af.recordAction(-1, 1, { source: 'deterministic', rule: 'sleeper_awakened_promo', confidence: 90, reason: 'test' })
  const r = af.queryLastAction(-1, 1)
  assert.ok(r)
  assert.strictEqual(r.source, 'deterministic')
  assert.strictEqual(r.rule, 'sleeper_awakened_promo')
})

test('registerOverride bumps fp counter for matching source', () => {
  af._resetForTests()
  af.recordAction(-1, 42, { source: 'openrouter_llm', rule: null, confidence: 85 })
  const r = af.registerOverride(-1, 42)
  assert.ok(r)
  assert.strictEqual(r.sourceKey, 'openrouter_llm')
  assert.strictEqual(r.count, 1)
  // Second override on different user → count becomes 2 for same source
  af.recordAction(-1, 43, { source: 'openrouter_llm' })
  const r2 = af.registerOverride(-1, 43)
  assert.strictEqual(r2.count, 2)
})

test('registerOverride returns null when no action recorded', () => {
  af._resetForTests()
  assert.strictEqual(af.registerOverride(-1, 999), null)
})

test('digest: top-N by FP count', () => {
  af._resetForTests()
  // 3 overrides for ruleA, 1 for ruleB
  af.recordAction(-1, 1, { source: 'determ', rule: 'ruleA' })
  af.registerOverride(-1, 1)
  af.recordAction(-1, 2, { source: 'determ', rule: 'ruleA' })
  af.registerOverride(-1, 2)
  af.recordAction(-1, 3, { source: 'determ', rule: 'ruleA' })
  af.registerOverride(-1, 3)
  af.recordAction(-1, 4, { source: 'determ', rule: 'ruleB' })
  af.registerOverride(-1, 4)
  const top = af.digest(5)
  assert.strictEqual(top[0].sourceKey, 'determ::ruleA')
  assert.strictEqual(top[0].count, 3)
  assert.strictEqual(top[1].sourceKey, 'determ::ruleB')
})

let passed = 0; let failed = 0
for (const t of tests) {
  try { t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
