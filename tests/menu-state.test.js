const assert = require('assert')
const { getState, setState, clearState, cleanupExpired } = require('../helpers/menu/state')
const policy = require('../helpers/cleanup-policy')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkGroup = (entries = []) => ({
  settings: { menuState: entries.map(e => ({ ...e })) }
})

test('setState appends a new entry with expiresAt = now + menu_state TTL', () => {
  const group = mkGroup()
  const before = Date.now()
  setState(group, 42, 's:r', { page: 1 })
  assert.strictEqual(group.settings.menuState.length, 1)
  const e = group.settings.menuState[0]
  assert.strictEqual(e.userId, 42)
  assert.strictEqual(e.screen, 's:r')
  assert.deepStrictEqual(e.data, { page: 1 })
  const expectedExpiry = before + policy.menu_state
  assert.ok(Math.abs(e.expiresAt.getTime() - expectedExpiry) < 5_000)
})

test('setState replaces existing entry for the same user (no duplicates)', () => {
  const group = mkGroup()
  setState(group, 42, 's:r', { page: 1 })
  setState(group, 42, 's:r', { page: 2 })
  assert.strictEqual(group.settings.menuState.length, 1)
  assert.deepStrictEqual(group.settings.menuState[0].data, { page: 2 })
})

test('setState keeps separate entries for different users', () => {
  const group = mkGroup()
  setState(group, 42, 's:r', { a: 1 })
  setState(group, 99, 's:r', { b: 2 })
  assert.strictEqual(group.settings.menuState.length, 2)
})

test('getState returns the entry data for the user/screen', () => {
  const group = mkGroup()
  setState(group, 42, 's:r', { page: 3 })
  assert.deepStrictEqual(getState(group, 42, 's:r'), { page: 3 })
})

test('getState returns null for missing entry', () => {
  const group = mkGroup()
  assert.strictEqual(getState(group, 42, 's:r'), null)
})

test('getState returns null for expired entry and removes it from array', () => {
  const group = mkGroup([{
    userId: 42, screen: 's:r', data: { x: 1 },
    expiresAt: new Date(Date.now() - 1000)
  }])
  assert.strictEqual(getState(group, 42, 's:r'), null)
  assert.strictEqual(group.settings.menuState.length, 0)
})

test('clearState removes the entry', () => {
  const group = mkGroup()
  setState(group, 42, 's:r', {})
  clearState(group, 42, 's:r')
  assert.strictEqual(group.settings.menuState.length, 0)
})

test('clearState is no-op for missing entry', () => {
  const group = mkGroup()
  clearState(group, 42, 's:r')
  assert.strictEqual(group.settings.menuState.length, 0)
})

test('cleanupExpired removes only expired entries', () => {
  const group = mkGroup([
    { userId: 1, screen: 'a', data: {}, expiresAt: new Date(Date.now() - 1000) },
    { userId: 2, screen: 'b', data: {}, expiresAt: new Date(Date.now() + 60_000) }
  ])
  cleanupExpired(group)
  assert.strictEqual(group.settings.menuState.length, 1)
  assert.strictEqual(group.settings.menuState[0].userId, 2)
})

test('handles missing settings.menuState gracefully (initializes)', () => {
  const group = { settings: {} }
  setState(group, 1, 's', { x: 1 })
  assert.strictEqual(group.settings.menuState.length, 1)
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
