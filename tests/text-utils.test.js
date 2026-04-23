const assert = require('assert')
const { bar, truncate } = require('../helpers/text-utils')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('bar default length is 10', () => {
  assert.strictEqual(bar(50).length, 10)
})

test('bar at 0% is all empty glyphs', () => {
  assert.strictEqual(bar(0, 10), '▱▱▱▱▱▱▱▱▱▱')
})

test('bar at 100% is all full glyphs', () => {
  assert.strictEqual(bar(100, 10), '▮▮▮▮▮▮▮▮▮▮')
})

test('bar at 50% (10 cells) is 5 full + 5 empty', () => {
  assert.strictEqual(bar(50, 10), '▮▮▮▮▮▱▱▱▱▱')
})

test('bar clamps percent < 0 to 0', () => {
  assert.strictEqual(bar(-50, 4), '▱▱▱▱')
})

test('bar clamps percent > 100 to 100', () => {
  assert.strictEqual(bar(500, 4), '▮▮▮▮')
})

test('bar handles NaN as 0', () => {
  assert.strictEqual(bar(NaN, 6), '▱▱▱▱▱▱')
})

test('bar honors custom glyphs', () => {
  assert.strictEqual(bar(50, 4, { full: '#', empty: '.' }), '##..')
})

test('bar rounds to nearest cell (42% of 10 → 4 full)', () => {
  assert.strictEqual(bar(42, 10), '▮▮▮▮▱▱▱▱▱▱')
})

test('truncate returns identity when under limit', () => {
  assert.strictEqual(truncate('hello', 10), 'hello')
})

test('truncate adds ellipsis when over limit', () => {
  assert.strictEqual(truncate('hello world', 8), 'hello w…')
})

test('truncate handles empty / null', () => {
  assert.strictEqual(truncate('', 5), '')
  assert.strictEqual(truncate(null, 5), '')
  assert.strictEqual(truncate(undefined, 5), '')
})

test('truncate custom ellipsis', () => {
  assert.strictEqual(truncate('abcdefgh', 5, '...'), 'ab...')
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
