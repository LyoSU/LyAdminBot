const assert = require('assert')
const policy = require('../helpers/cleanup-policy')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('exports all expected keys', () => {
  const expected = [
    'cmd_help',
    'cmd_settings_idle',
    'vote_result',
    'mod_event',
    'mod_event_compact',
    'mod_event_expanded',
    'mod_event_override',
    'vote_post_result_btn',
    'banan_undo',
    'onboarding_ack',
    'confirm_screen',
    'quick_picker',
    'menu_state'
  ]
  for (const k of expected) {
    assert.ok(typeof policy[k] === 'number' && policy[k] > 0, `missing or non-positive: ${k}`)
  }
})

test('values are in milliseconds (sanity: between 5s and 1h)', () => {
  for (const [k, v] of Object.entries(policy)) {
    assert.ok(v >= 5_000 && v <= 60 * 60_000, `${k}=${v} out of expected range`)
  }
})

test('menu_state is the longest TTL (10min)', () => {
  assert.strictEqual(policy.menu_state, 10 * 60 * 1000)
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) }
    catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
