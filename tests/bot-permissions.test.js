const assert = require('assert')
const botPermissions = require('../helpers/bot-permissions')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('fromMember: administrator with full rights', () => {
  const p = botPermissions.fromMember({
    status: 'administrator',
    can_delete_messages: true,
    can_restrict_members: true
  })
  assert.deepStrictEqual(p, { isAdmin: true, canDelete: true, canRestrict: true, canAct: true })
})

test('fromMember: member (not admin) → canAct false', () => {
  const p = botPermissions.fromMember({
    status: 'member',
    can_delete_messages: false,
    can_restrict_members: false
  })
  assert.strictEqual(p.isAdmin, false)
  assert.strictEqual(p.canAct, false)
})

test('fromMember: admin WITHOUT delete/restrict → canAct false', () => {
  const p = botPermissions.fromMember({
    status: 'administrator',
    can_delete_messages: false,
    can_restrict_members: false
  })
  assert.strictEqual(p.isAdmin, true)
  assert.strictEqual(p.canAct, false, 'admin with no perms still cannot act')
})

test('fromMember: admin with only delete → canAct true', () => {
  const p = botPermissions.fromMember({
    status: 'administrator',
    can_delete_messages: true,
    can_restrict_members: false
  })
  assert.strictEqual(p.canAct, true)
})

test('fromMember: null/undefined → null (no crash)', () => {
  assert.strictEqual(botPermissions.fromMember(null), null)
  assert.strictEqual(botPermissions.fromMember(undefined), null)
})

test('setFromMember + get: round-trip', () => {
  botPermissions._resetForTests()
  botPermissions.setFromMember(-100, {
    status: 'administrator',
    can_delete_messages: true,
    can_restrict_members: true
  })
  const got = botPermissions.get(-100)
  assert.ok(got)
  assert.strictEqual(got.canAct, true)
})

test('get: miss returns null, never crashes on bad key', () => {
  botPermissions._resetForTests()
  assert.strictEqual(botPermissions.get(-999), null)
  assert.strictEqual(botPermissions.get(null), null)
  assert.strictEqual(botPermissions.get(undefined), null)
})

test('resolve: cache hit skips API call', async () => {
  botPermissions._resetForTests()
  botPermissions.setFromMember(-100, { status: 'administrator', can_delete_messages: true, can_restrict_members: false })
  let apiCalled = false
  const telegram = { getChatMember: async () => { apiCalled = true; return {} } }
  const perms = await botPermissions.resolve(telegram, -100, 999)
  assert.strictEqual(apiCalled, false)
  assert.strictEqual(perms.canAct, true)
})

test('resolve: cache miss → fetches via API and caches', async () => {
  botPermissions._resetForTests()
  let apiCalls = 0
  const telegram = {
    getChatMember: async (chatId, botId) => {
      apiCalls++
      assert.strictEqual(chatId, -200)
      assert.strictEqual(botId, 42)
      return { status: 'member', can_delete_messages: false, can_restrict_members: false }
    }
  }
  const first = await botPermissions.resolve(telegram, -200, 42)
  const second = await botPermissions.resolve(telegram, -200, 42)
  assert.strictEqual(apiCalls, 1, 'second call should hit the cache')
  assert.strictEqual(first.canAct, false)
  assert.strictEqual(second.canAct, false)
})

test('resolve: API error → null (graceful)', async () => {
  botPermissions._resetForTests()
  const telegram = { getChatMember: async () => { throw new Error('chat not found') } }
  const perms = await botPermissions.resolve(telegram, -300, 42)
  assert.strictEqual(perms, null)
})

test('resolve: missing telegram client → null (no crash)', async () => {
  botPermissions._resetForTests()
  assert.strictEqual(await botPermissions.resolve(null, -100, 42), null)
  assert.strictEqual(await botPermissions.resolve({}, -100, null), null)
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
