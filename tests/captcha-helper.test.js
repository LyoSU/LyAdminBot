const assert = require('assert')
const captcha = require('../helpers/captcha')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('generateChallenge returns 6 options', () => {
  const ch = captcha.generateChallenge('mid_confidence')
  assert.strictEqual(ch.options.length, 6)
})

test('generateChallenge includes the correct emoji exactly once', () => {
  for (let i = 0; i < 50; i++) {
    const ch = captcha.generateChallenge('mid_confidence')
    const matches = ch.options.filter(o => o.emoji === ch.correctEmoji)
    assert.strictEqual(matches.length, 1, 'correct emoji must appear exactly once')
  }
})

test('generateChallenge options are all distinct', () => {
  for (let i = 0; i < 50; i++) {
    const ch = captcha.generateChallenge('mid_confidence')
    const set = new Set(ch.options.map(o => o.emoji))
    assert.strictEqual(set.size, ch.options.length, 'options must be unique')
  }
})

test('generateChallenge options are drawn from the pool', () => {
  const poolEmojis = new Set(captcha.POOL.map(p => p.emoji))
  for (let i = 0; i < 20; i++) {
    const ch = captcha.generateChallenge('mid_confidence')
    for (const opt of ch.options) {
      assert.ok(poolEmojis.has(opt.emoji), 'option must be drawn from POOL: ' + opt.emoji)
      assert.ok(opt.nameKey.startsWith('captcha.emoji.'), 'nameKey namespaced: ' + opt.nameKey)
    }
  }
})

test('generateChallenge kind propagates', () => {
  const ch = captcha.generateChallenge('global_ban_appeal')
  assert.strictEqual(ch.kind, 'global_ban_appeal')
})

test('verifyChallenge returns ok on correct pick, without mutating attemptsLeft', () => {
  const row = { attemptsLeft: 3, correctEmoji: '🍌' }
  const v = captcha.verifyChallenge(row, '🍌')
  assert.strictEqual(v.ok, true)
  assert.strictEqual(v.attemptsLeft, 3)
  assert.strictEqual(row.attemptsLeft, 3)
})

test('verifyChallenge decrements on wrong pick', () => {
  const row = { attemptsLeft: 3, correctEmoji: '🍌' }
  const v1 = captcha.verifyChallenge(row, '🍎')
  assert.strictEqual(v1.ok, false)
  assert.strictEqual(v1.attemptsLeft, 2)
  assert.strictEqual(row.attemptsLeft, 2)
  const v2 = captcha.verifyChallenge(row, '🐱')
  assert.strictEqual(v2.ok, false)
  assert.strictEqual(v2.attemptsLeft, 1)
  const v3 = captcha.verifyChallenge(row, '🐶')
  assert.strictEqual(v3.attemptsLeft, 0)
})

test('verifyChallenge returns ok:false when row is null', () => {
  const v = captcha.verifyChallenge(null, '🍌')
  assert.strictEqual(v.ok, false)
  assert.strictEqual(v.attemptsLeft, 0)
})

test('verifyChallenge handles missing pick gracefully', () => {
  const row = { attemptsLeft: 3, correctEmoji: '🍌' }
  const v = captcha.verifyChallenge(row, null)
  assert.strictEqual(v.ok, false)
  assert.strictEqual(v.attemptsLeft, 3) // must not burn an attempt on bad input
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
