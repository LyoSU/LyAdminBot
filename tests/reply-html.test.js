const assert = require('assert')
const { replyHTML, editHTML } = require('../helpers/reply-html')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = () => {
  const calls = []
  return {
    chat: { id: -100 },
    telegram: {
      callApi: async (method, payload) => { calls.push({ method, payload }); return { message_id: 42 } }
    },
    _calls: calls
  }
}

test('replyHTML sends sendMessage with HTML parse_mode and link_preview disabled', async () => {
  const ctx = mkCtx()
  await replyHTML(ctx, '<b>hi</b>')
  assert.strictEqual(ctx._calls.length, 1)
  const c = ctx._calls[0]
  assert.strictEqual(c.method, 'sendMessage')
  assert.strictEqual(c.payload.chat_id, -100)
  assert.strictEqual(c.payload.text, '<b>hi</b>')
  assert.strictEqual(c.payload.parse_mode, 'HTML')
  assert.deepStrictEqual(c.payload.link_preview_options, { is_disabled: true })
  assert.strictEqual(c.payload.disable_web_page_preview, true)
})

test('replyHTML accepts reply_to_message_id and converts to reply_parameters', async () => {
  const ctx = mkCtx()
  await replyHTML(ctx, 'x', { reply_to_message_id: 7 })
  const c = ctx._calls[0]
  assert.deepStrictEqual(c.payload.reply_parameters, { message_id: 7 })
  // legacy form left intact for telegraf 3.33 compatibility
  assert.strictEqual(c.payload.reply_to_message_id, 7)
})

test('replyHTML passes through reply_markup unchanged', async () => {
  const ctx = mkCtx()
  const kb = { inline_keyboard: [[{ text: 'a', callback_data: 'b' }]] }
  await replyHTML(ctx, 'x', { reply_markup: kb })
  assert.deepStrictEqual(ctx._calls[0].payload.reply_markup, kb)
})

test('replyHTML allows caller to override link_preview defaults', async () => {
  const ctx = mkCtx()
  await replyHTML(ctx, 'x', { link_preview_options: { is_disabled: false } })
  const c = ctx._calls[0]
  assert.deepStrictEqual(c.payload.link_preview_options, { is_disabled: false })
  assert.strictEqual(c.payload.disable_web_page_preview, false)
})

test('replyHTML: link_preview_options with url (no is_disabled) defaults to enabled', async () => {
  const ctx = mkCtx()
  await replyHTML(ctx, 'x', { link_preview_options: { url: 'https://example.com' } })
  const c = ctx._calls[0]
  assert.deepStrictEqual(c.payload.link_preview_options, { url: 'https://example.com' })
  assert.strictEqual(c.payload.disable_web_page_preview, false)
})

test('editHTML calls editMessageText with same defaults', async () => {
  const ctx = mkCtx()
  await editHTML(ctx, 100, '<i>x</i>')
  const c = ctx._calls[0]
  assert.strictEqual(c.method, 'editMessageText')
  assert.strictEqual(c.payload.chat_id, -100)
  assert.strictEqual(c.payload.message_id, 100)
  assert.strictEqual(c.payload.text, '<i>x</i>')
  assert.strictEqual(c.payload.parse_mode, 'HTML')
  assert.deepStrictEqual(c.payload.link_preview_options, { is_disabled: true })
})

test('editHTML returns the edited message id from telegram', async () => {
  const ctx = mkCtx()
  const result = await editHTML(ctx, 100, 'x')
  assert.strictEqual(result.message_id, 42)
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
