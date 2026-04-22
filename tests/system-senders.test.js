const assert = require('assert')
const { isSystemSender, isSystemSenderId, SYSTEM_SENDER_IDS } = require('../helpers/system-senders')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('isSystemSenderId: covers Telegram (777000)', () => {
  assert.strictEqual(isSystemSenderId(777000), true)
})

test('isSystemSenderId: covers Group Anonymous Bot (1087968824)', () => {
  assert.strictEqual(isSystemSenderId(1087968824), true)
})

test('isSystemSenderId: covers Channel Bot (136817688)', () => {
  assert.strictEqual(isSystemSenderId(136817688), true)
})

test('isSystemSenderId: accepts numeric strings', () => {
  assert.strictEqual(isSystemSenderId('777000'), true)
})

test('isSystemSenderId: ordinary user ids are NOT system', () => {
  assert.strictEqual(isSystemSenderId(42), false)
  assert.strictEqual(isSystemSenderId(1234567890), false)
  assert.strictEqual(isSystemSenderId(null), false)
  assert.strictEqual(isSystemSenderId(undefined), false)
})

test('isSystemSender(ctx): true for system from.id', () => {
  assert.strictEqual(isSystemSender({ from: { id: 777000 } }), true)
  assert.strictEqual(isSystemSender({ from: { id: 1087968824 } }), true)
})

test('isSystemSender(ctx): false for normal user', () => {
  assert.strictEqual(isSystemSender({ from: { id: 5000000001 } }), false)
})

test('isSystemSender(ctx): safe on missing ctx.from', () => {
  assert.strictEqual(isSystemSender({}), false)
  assert.strictEqual(isSystemSender(null), false)
})

test('SYSTEM_SENDER_IDS is a Set with 3 well-known ids', () => {
  assert.ok(SYSTEM_SENDER_IDS instanceof Set)
  assert.strictEqual(SYSTEM_SENDER_IDS.size, 3)
})

let passed = 0; let failed = 0
for (const t of tests) {
  try { t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
