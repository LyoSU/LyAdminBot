const assert = require('assert')
const { startInputFlow, consumeInput } = require('../helpers/menu/flows')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = ({ chatId = -100, fromId = 1, group = { info: { settings: {} } } } = {}) => {
  const calls = []
  return {
    chat: { id: chatId },
    from: { id: fromId },
    group,
    telegram: {
      callApi: async (method, payload) => { calls.push({ method, payload }); return { message_id: 77 } }
    },
    _calls: calls
  }
}

test('startInputFlow sends a force_reply prompt and stores pendingInput', async () => {
  const ctx = mkCtx()
  await startInputFlow(ctx, { type: 'spam_allow', screen: 's:rules', prompt: 'Enter rule text' })

  // sent prompt
  assert.strictEqual(ctx._calls.length, 1)
  const p = ctx._calls[0].payload
  assert.strictEqual(p.text, 'Enter rule text')
  assert.deepStrictEqual(p.reply_markup, { force_reply: true, selective: true })

  // pendingInput stored
  const pi = ctx.group.info.settings.pendingInput
  assert.strictEqual(pi.userId, 1)
  assert.strictEqual(pi.type, 'spam_allow')
  assert.strictEqual(pi.screen, 's:rules')
  assert.strictEqual(pi.promptMsgId, 77)
  assert.ok(pi.expiresAt instanceof Date)
  assert.ok(pi.expiresAt.getTime() > Date.now())
})

test('startInputFlow overwrites a previous pendingInput in the same group', async () => {
  const ctx = mkCtx()
  await startInputFlow(ctx, { type: 'a', screen: 's:1', prompt: '1' })
  await startInputFlow(ctx, { type: 'b', screen: 's:2', prompt: '2' })
  assert.strictEqual(ctx.group.info.settings.pendingInput.type, 'b')
})

test('consumeInput returns matching pendingInput and clears it', () => {
  const expiresAt = new Date(Date.now() + 60_000)
  const ctx = mkCtx({
    group: {
      info: { settings: { pendingInput: { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt } } }
    }
  })
  const result = consumeInput(ctx)
  assert.deepStrictEqual(result, { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt })
  assert.strictEqual(ctx.group.info.settings.pendingInput, undefined)
})

test('consumeInput returns null when no pendingInput', () => {
  const ctx = mkCtx()
  assert.strictEqual(consumeInput(ctx), null)
})

test('consumeInput returns null when expired and clears it', () => {
  const ctx = mkCtx({
    group: {
      info: { settings: { pendingInput: { userId: 1, type: 't', screen: 's', expiresAt: new Date(Date.now() - 1) } } }
    }
  })
  assert.strictEqual(consumeInput(ctx), null)
  assert.strictEqual(ctx.group.info.settings.pendingInput, undefined)
})

test('consumeInput returns null when from.id does not match userId in pendingInput', () => {
  const ctx = mkCtx({
    fromId: 999,
    group: {
      info: { settings: { pendingInput: { userId: 1, type: 't', screen: 's', expiresAt: new Date(Date.now() + 60_000) } } }
    }
  })
  assert.strictEqual(consumeInput(ctx), null)
  // pendingInput stays — wrong user shouldn't clear someone else's prompt
  assert.ok(ctx.group.info.settings.pendingInput)
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
