const assert = require('assert')
const { isSenderAdmin } = require('../helpers/is-sender-admin')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = ({ chatId, fromId, senderChat, getChatMember }) => ({
  chat: { id: chatId },
  message: {
    from: { id: fromId },
    sender_chat: senderChat || null
  },
  telegram: {
    getChatMember: getChatMember || (async () => { throw new Error('unexpected') })
  }
})

test('anonymous admin (sender_chat.id === chat.id) → true w/o API call', async () => {
  let apiCalled = false
  const ctx = mkCtx({
    chatId: -100,
    fromId: 1087968824,
    senderChat: { id: -100, type: 'supergroup' },
    getChatMember: async () => { apiCalled = true; return null }
  })
  assert.strictEqual(await isSenderAdmin(ctx), true)
  assert.strictEqual(apiCalled, false, 'should NOT call getChatMember for anonymous admin')
})

test('regular user with admin status → true (via API)', async () => {
  const ctx = mkCtx({
    chatId: -100,
    fromId: 999,
    getChatMember: async (chatId, userId) => {
      assert.strictEqual(chatId, -100)
      assert.strictEqual(userId, 999)
      return { status: 'administrator' }
    }
  })
  assert.strictEqual(await isSenderAdmin(ctx), true)
})

test('regular user with creator status → true', async () => {
  const ctx = mkCtx({
    chatId: -100,
    fromId: 999,
    getChatMember: async () => ({ status: 'creator' })
  })
  assert.strictEqual(await isSenderAdmin(ctx), true)
})

test('regular member → false', async () => {
  const ctx = mkCtx({
    chatId: -100,
    fromId: 999,
    getChatMember: async () => ({ status: 'member' })
  })
  assert.strictEqual(await isSenderAdmin(ctx), false)
})

test('user posting AS channel (sender_chat.type === channel, different id) → NOT admin', async () => {
  const ctx = mkCtx({
    chatId: -100,
    fromId: 136817688,
    senderChat: { id: -200, type: 'channel' },
    getChatMember: async () => ({ status: 'member' })
  })
  assert.strictEqual(await isSenderAdmin(ctx), false)
})

test('getChatMember throws → false (does not crash)', async () => {
  const ctx = mkCtx({
    chatId: -100,
    fromId: 999,
    getChatMember: async () => { throw new Error('API down') }
  })
  assert.strictEqual(await isSenderAdmin(ctx), false)
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
