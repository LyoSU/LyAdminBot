const assert = require('assert')
const { parseStartPayload } = require('../handlers/start')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('no payload → { kind: none }', () => {
  assert.deepStrictEqual(parseStartPayload(''), { kind: 'none' })
  assert.deepStrictEqual(parseStartPayload(null), { kind: 'none' })
  assert.deepStrictEqual(parseStartPayload(undefined), { kind: 'none' })
  assert.deepStrictEqual(parseStartPayload('   '), { kind: 'none' })
})

test('help payload → { kind: help }', () => {
  assert.deepStrictEqual(parseStartPayload('help'), { kind: 'help' })
})

test('settings_<chatId> → { kind: settings, chatId }', () => {
  assert.deepStrictEqual(parseStartPayload('settings_-1001234567890'), { kind: 'settings', chatId: -1001234567890 })
  assert.deepStrictEqual(parseStartPayload('settings_42'), { kind: 'settings', chatId: 42 })
})

test('mystats_<chatId> → { kind: mystats, chatId }', () => {
  assert.deepStrictEqual(parseStartPayload('mystats_-100500'), { kind: 'mystats', chatId: -100500 })
})

test('mod_event_<eventId> → { kind: mod_event, eventId }', () => {
  assert.deepStrictEqual(parseStartPayload('mod_event_a1b2c3d4e5f6'), { kind: 'mod_event', eventId: 'a1b2c3d4e5f6' })
  // Case-insensitive hex
  assert.deepStrictEqual(parseStartPayload('mod_event_DEADBEEF'), { kind: 'mod_event', eventId: 'DEADBEEF' })
  // Non-hex chars → unknown
  assert.deepStrictEqual(parseStartPayload('mod_event_xyz'), { kind: 'unknown', raw: 'mod_event_xyz' })
})

test('unknown payload → { kind: unknown, raw }', () => {
  assert.deepStrictEqual(parseStartPayload('foobar'), { kind: 'unknown', raw: 'foobar' })
  // Malformed settings (no chatId) → unknown
  assert.deepStrictEqual(parseStartPayload('settings_notanumber'), { kind: 'unknown', raw: 'settings_notanumber' })
  // Non-matching prefix → unknown
  assert.deepStrictEqual(parseStartPayload('mystats-1000'), { kind: 'unknown', raw: 'mystats-1000' })
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
