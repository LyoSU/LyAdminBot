const assert = require('assert')
const { setReaction, ack, ackOnTarget, silent, REACTIONS } = require('../helpers/reactions')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = ({ throws } = {}) => {
  const calls = []
  return {
    chat: { id: -100 },
    message: { message_id: 5 },
    telegram: {
      callApi: async (method, payload) => {
        calls.push({ method, payload })
        if (throws) throw new Error(throws)
        return true
      }
    },
    _calls: calls
  }
}

test('REACTIONS exports the agreed emoji vocabulary', () => {
  for (const k of ['del', 'banan', 'report', 'extraSaved', 'trustOk']) {
    assert.ok(typeof REACTIONS[k] === 'string' && REACTIONS[k].length > 0, `missing: ${k}`)
  }
})

test('setReaction calls setMessageReaction with emoji-type reaction', async () => {
  const ctx = mkCtx()
  await setReaction(ctx, -100, 5, '🍌')
  assert.strictEqual(ctx._calls.length, 1)
  const c = ctx._calls[0]
  assert.strictEqual(c.method, 'setMessageReaction')
  assert.strictEqual(c.payload.chat_id, -100)
  assert.strictEqual(c.payload.message_id, 5)
  assert.deepStrictEqual(c.payload.reaction, [{ type: 'emoji', emoji: '🍌' }])
})

test('setReaction with empty emoji clears the reaction', async () => {
  const ctx = mkCtx()
  await setReaction(ctx, -100, 5, null)
  const c = ctx._calls[0]
  assert.deepStrictEqual(c.payload.reaction, [])
})

test('setReaction swallows errors and returns false', async () => {
  const ctx = mkCtx({ throws: 'reactions disabled' })
  const result = await setReaction(ctx, -100, 5, '🍌')
  assert.strictEqual(result, false)
})

test('setReaction returns true on success', async () => {
  const ctx = mkCtx()
  const result = await setReaction(ctx, -100, 5, '🍌')
  assert.strictEqual(result, true)
})

test('ack reacts to ctx.message.message_id in ctx.chat', async () => {
  const ctx = mkCtx()
  await ack(ctx, '✓')
  const c = ctx._calls[0]
  assert.strictEqual(c.payload.chat_id, -100)
  assert.strictEqual(c.payload.message_id, 5)
})

test('ackOnTarget reacts to a specific message id', async () => {
  const ctx = mkCtx()
  await ackOnTarget(ctx, 999, '🚫')
  assert.strictEqual(ctx._calls[0].payload.message_id, 999)
})

test('silent uses REACTIONS.report (👀)', async () => {
  const ctx = mkCtx()
  await silent(ctx)
  assert.strictEqual(ctx._calls[0].payload.reaction[0].emoji, REACTIONS.report)
})

test('ack with no ctx.message is a no-op (no API call, returns false)', async () => {
  const ctx = { chat: { id: -100 }, telegram: { callApi: async () => { throw new Error('should not call') } } }
  const result = await ack(ctx, '✓')
  assert.strictEqual(result, false)
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
