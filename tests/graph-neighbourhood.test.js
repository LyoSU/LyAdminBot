const assert = require('assert')
const gn = require('../helpers/graph-neighbourhood')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('no bans → no taint', () => {
  gn._resetForTests()
  const r = gn.queryNeighbourhood({ userId: 1, chats: [-100], firstSeenAt: new Date() })
  assert.strictEqual(r, null)
})

test('shared chat + same-day join → soft neighbour', () => {
  gn._resetForTests()
  const now = new Date()
  gn.registerBan(100, { chats: [-1, -2, -3], firstSeenAt: now })
  const r = gn.queryNeighbourhood({
    userId: 101,
    chats: [-3, -999],
    firstSeenAt: new Date(now.getTime() + 10 * 60 * 60 * 1000) // 10h later
  })
  assert.ok(r)
  assert.strictEqual(r.tier, 'neighbour')
  assert.strictEqual(r.sharedChats, 1)
})

test('2+ shared chats + <1h gap → coordinated', () => {
  gn._resetForTests()
  const now = new Date()
  gn.registerBan(200, { chats: [-10, -11, -12], firstSeenAt: now })
  const r = gn.queryNeighbourhood({
    userId: 201,
    chats: [-10, -11, -99],
    firstSeenAt: new Date(now.getTime() + 30 * 60 * 1000) // 30 min later
  })
  assert.ok(r)
  assert.strictEqual(r.tier, 'coordinated')
  assert.strictEqual(r.sharedChats, 2)
})

test('no chat overlap → no taint even with close join time', () => {
  gn._resetForTests()
  gn.registerBan(300, { chats: [-50], firstSeenAt: new Date() })
  const r = gn.queryNeighbourhood({
    userId: 301,
    chats: [-99],
    firstSeenAt: new Date()
  })
  assert.strictEqual(r, null)
})

test('join gap > 24h → no soft tier', () => {
  gn._resetForTests()
  const bannedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  gn.registerBan(400, { chats: [-7], firstSeenAt: bannedAt })
  const r = gn.queryNeighbourhood({
    userId: 401,
    chats: [-7],
    firstSeenAt: new Date() // 48h later
  })
  assert.strictEqual(r, null)
})

test('self-ban not counted', () => {
  gn._resetForTests()
  gn.registerBan(500, { chats: [-5], firstSeenAt: new Date() })
  // Query user 500 themselves — the code must skip own entry
  const r = gn.queryNeighbourhood({ userId: 500, chats: [-5], firstSeenAt: new Date() })
  assert.strictEqual(r, null)
})

let passed = 0; let failed = 0
for (const t of tests) {
  try { t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
