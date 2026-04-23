const assert = require('assert')
const { withTyping, DEFAULT_INTERVAL_MS } = require('../helpers/typing')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = () => {
  const calls = []
  return {
    calls,
    chat: { id: -100 },
    telegram: {
      sendChatAction: async (chatId, action) => {
        calls.push({ chatId, action, at: Date.now() })
      }
    }
  }
}

test('withTyping sends immediate chat action', async () => {
  const ctx = mkCtx()
  await withTyping(ctx, async () => 'ok')
  assert.ok(ctx.calls.length >= 1, 'at least one sendChatAction')
  assert.strictEqual(ctx.calls[0].action, 'typing')
  assert.strictEqual(ctx.calls[0].chatId, -100)
})

test('withTyping returns fn return value', async () => {
  const ctx = mkCtx()
  const out = await withTyping(ctx, async () => 42)
  assert.strictEqual(out, 42)
})

test('withTyping propagates rejections from fn', async () => {
  const ctx = mkCtx()
  await assert.rejects(
    () => withTyping(ctx, async () => { throw new Error('boom') }),
    /boom/
  )
})

test('withTyping re-fires every interval (fake timers)', async () => {
  const ctx = mkCtx()
  // Use a short interval so we don't have to actually wait 4.5 s in tests.
  const p = withTyping(ctx, () => new Promise(resolve => setTimeout(resolve, 120)), {
    intervalMs: 40
  })
  await p
  // Initial call + at least 2 interval fires (~40, ~80, ~120 ms).
  assert.ok(ctx.calls.length >= 3, `expected >=3 calls, got ${ctx.calls.length}`)
})

test('withTyping works when ctx has no chat (skip action, still runs fn)', async () => {
  const calls = []
  const ctx = {
    telegram: { sendChatAction: async () => calls.push('x') }
    // no chat
  }
  const out = await withTyping(ctx, async () => 'done')
  assert.strictEqual(out, 'done')
  assert.strictEqual(calls.length, 0)
})

test('withTyping swallows sendChatAction errors silently', async () => {
  const ctx = {
    chat: { id: 1 },
    telegram: {
      sendChatAction: async () => { throw new Error('api down') }
    }
  }
  const out = await withTyping(ctx, async () => 'ok')
  assert.strictEqual(out, 'ok')
})

test('DEFAULT_INTERVAL_MS is 4500 per Bot API throttling', () => {
  assert.strictEqual(DEFAULT_INTERVAL_MS, 4500)
})

;(async () => {
  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      console.log('✓', t.name)
    } catch (err) {
      failed++
      console.error('✗', t.name, '—', err.message)
    }
  }
  if (failed) process.exit(1)
})()
