const assert = require('assert')
const { checkAccess } = require('../helpers/menu/access')
const adminCache = require('../helpers/admin-cache')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCb = ({ fromId, chatId, originatorId, getChatMember }) => ({
  from: { id: fromId },
  chat: { id: chatId },
  callbackQuery: { message: { reply_to_message: { from: { id: originatorId } } } },
  telegram: {
    getChatMember: getChatMember || (async () => ({ status: 'member' }))
  }
})

test('public access always passes', async () => {
  const ctx = mkCb({ fromId: 1, chatId: -100 })
  const result = await checkAccess(ctx, 'public')
  assert.strictEqual(result.ok, true)
})

test('group_admin passes for administrator', async () => {
  const ctx = mkCb({
    fromId: 1, chatId: -100,
    getChatMember: async () => ({ status: 'administrator' })
  })
  const result = await checkAccess(ctx, 'group_admin')
  assert.strictEqual(result.ok, true)
})

test('group_admin passes for creator', async () => {
  const ctx = mkCb({
    fromId: 1, chatId: -100,
    getChatMember: async () => ({ status: 'creator' })
  })
  const result = await checkAccess(ctx, 'group_admin')
  assert.strictEqual(result.ok, true)
})

test('group_admin denies regular member with toastKey', async () => {
  const ctx = mkCb({
    fromId: 1, chatId: -100,
    getChatMember: async () => ({ status: 'member' })
  })
  const result = await checkAccess(ctx, 'group_admin')
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.toastKey, 'menu.access.only_admins')
})

test('initiator passes when from.id matches initiatorId option', async () => {
  const ctx = mkCb({ fromId: 42, chatId: -100 })
  const result = await checkAccess(ctx, 'initiator', { initiatorId: 42 })
  assert.strictEqual(result.ok, true)
})

test('initiator denies when from.id does not match', async () => {
  const ctx = mkCb({ fromId: 99, chatId: -100 })
  const result = await checkAccess(ctx, 'initiator', { initiatorId: 42 })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.toastKey, 'menu.access.only_initiator')
})

test('group_admin_or_initiator passes for matching initiator who is not admin', async () => {
  const ctx = mkCb({
    fromId: 42, chatId: -100,
    getChatMember: async () => ({ status: 'member' })
  })
  const result = await checkAccess(ctx, 'group_admin_or_initiator', { initiatorId: 42 })
  assert.strictEqual(result.ok, true)
})

test('group_admin_or_initiator passes for any admin even without initiator match', async () => {
  const ctx = mkCb({
    fromId: 99, chatId: -100,
    getChatMember: async () => ({ status: 'administrator' })
  })
  const result = await checkAccess(ctx, 'group_admin_or_initiator', { initiatorId: 42 })
  assert.strictEqual(result.ok, true)
})

test('group_admin_or_initiator denies non-admin non-initiator', async () => {
  const ctx = mkCb({
    fromId: 99, chatId: -100,
    getChatMember: async () => ({ status: 'member' })
  })
  const result = await checkAccess(ctx, 'group_admin_or_initiator', { initiatorId: 42 })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.toastKey, 'menu.access.only_initiator_or_admin')
})

test('unknown rule denies with generic toastKey', async () => {
  const ctx = mkCb({ fromId: 1, chatId: -100 })
  const result = await checkAccess(ctx, 'mystery_rule')
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.toastKey, 'menu.access.denied')
})

test('group_admin denies if getChatMember throws', async () => {
  const ctx = mkCb({
    fromId: 1, chatId: -100,
    getChatMember: async () => { throw new Error('API down') }
  })
  const result = await checkAccess(ctx, 'group_admin')
  assert.strictEqual(result.ok, false)
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    // Clear admin cache between tests so cached results from earlier tests
    // (which use the same fromId+chatId pairs) don't leak.
    adminCache.clearAll()
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) }
    catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
