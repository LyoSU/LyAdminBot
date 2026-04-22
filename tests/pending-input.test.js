const assert = require('assert')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const fresh = () => {
  delete require.cache[require.resolve('../middlewares/pending-input')]
  return require('../middlewares/pending-input')
}

const mkCtx = ({
  text = 'reply text',
  fromId = 1,
  pendingInput = null,
  replyToBotPromptId = null
} = {}) => ({
  message: {
    text,
    message_id: 100,
    reply_to_message: replyToBotPromptId
      ? { message_id: replyToBotPromptId, from: { id: 12345, is_bot: true } }
      : null
  },
  from: { id: fromId },
  chat: { id: -100 },
  group: { info: { settings: { pendingInput } } }
})

test('passes through when no pendingInput', async () => {
  const { pendingInputMiddleware } = fresh()
  const ctx = mkCtx({ pendingInput: null })
  let nextCalled = false
  await pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(nextCalled, true)
})

test('passes through when message is not a reply', async () => {
  const { pendingInputMiddleware } = fresh()
  const ctx = mkCtx({
    pendingInput: { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt: new Date(Date.now() + 60_000) }
  })
  let nextCalled = false
  await pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(nextCalled, true)
})

test('passes through when reply is to a different message than the prompt', async () => {
  const { pendingInputMiddleware } = fresh()
  const ctx = mkCtx({
    pendingInput: { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt: new Date(Date.now() + 60_000) },
    replyToBotPromptId: 999
  })
  let nextCalled = false
  await pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(nextCalled, true)
})

test('invokes registered handler when reply matches and from matches user', async () => {
  const mod = fresh()
  let received = null
  mod.registerInputHandler('mytype', async (ctx, input, pi) => { received = { input, pi } })
  const expiresAt = new Date(Date.now() + 60_000)
  const ctx = mkCtx({
    text: 'hello world',
    pendingInput: { userId: 1, type: 'mytype', screen: 's', promptMsgId: 7, expiresAt },
    replyToBotPromptId: 7
  })
  let nextCalled = false
  await mod.pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(nextCalled, false)
  assert.strictEqual(received.input, 'hello world')
  assert.strictEqual(received.pi.type, 'mytype')
  assert.strictEqual(ctx.group.info.settings.pendingInput, undefined)
})

test('passes through when type has no registered handler', async () => {
  const mod = fresh()
  const ctx = mkCtx({
    pendingInput: { userId: 1, type: 'unknown', screen: 's', promptMsgId: 7, expiresAt: new Date(Date.now() + 60_000) },
    replyToBotPromptId: 7
  })
  let nextCalled = false
  await mod.pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(nextCalled, true)
})

test('passes through when from.id does not match pendingInput.userId', async () => {
  const mod = fresh()
  let handlerCalled = false
  mod.registerInputHandler('t', async () => { handlerCalled = true })
  const ctx = mkCtx({
    fromId: 999,
    pendingInput: { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt: new Date(Date.now() + 60_000) },
    replyToBotPromptId: 7
  })
  let nextCalled = false
  await mod.pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(handlerCalled, false)
  assert.strictEqual(nextCalled, true)
})

test('passes through when pendingInput is expired', async () => {
  const mod = fresh()
  let handlerCalled = false
  mod.registerInputHandler('t', async () => { handlerCalled = true })
  const ctx = mkCtx({
    pendingInput: { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt: new Date(Date.now() - 1) },
    replyToBotPromptId: 7
  })
  let nextCalled = false
  await mod.pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(handlerCalled, false)
  assert.strictEqual(nextCalled, true)
})

test('handler errors do not bubble up; next is NOT called', async () => {
  const mod = fresh()
  mod.registerInputHandler('t', async () => { throw new Error('boom') })
  const ctx = mkCtx({
    pendingInput: { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt: new Date(Date.now() + 60_000) },
    replyToBotPromptId: 7
  })
  let nextCalled = false
  await mod.pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(nextCalled, false) // handler claimed the message even on error
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
