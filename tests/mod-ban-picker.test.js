// Tests for the /banan quick-picker screen (§6 of the UX design).
// Covers: registration, keyboard shape, callback dispatch → performBan,
// permanent-ban path, cancel short-circuit via reserved _close token.

const assert = require('assert')
const path = require('path')
const I18n = require('telegraf-i18n')
const emojiMap = require('../helpers/emoji-map')

delete require.cache[require.resolve('../helpers/menu/registry')]
delete require.cache[require.resolve('../helpers/menu/screens/mod-ban-picker')]

const picker = require('../helpers/menu/screens/mod-ban-picker')
const registry = require('../helpers/menu/registry')

const i18nLoader = new I18n({
  directory: path.resolve(__dirname, '..', 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

const mkI18n = (lang = 'uk') => ({
  t: (k, vars = {}) => i18nLoader.t(lang, k, { e: emojiMap, ...vars }),
  locale: () => lang
})

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('screen registers at id mod.ban.picker with group_admin access', () => {
  try { picker.register() } catch (e) { if (!/already registered/.test(e.message)) throw e }
  const s = registry.getMenu('mod.ban.picker')
  assert.ok(s, 'screen registered')
  assert.strictEqual(s.access, 'group_admin')
})

test('renderPicker produces text + 4-row keyboard (durations + forever + cancel)', () => {
  const ctx = { i18n: mkI18n('uk') }
  const view = picker.renderPicker(ctx, { targetName: 'Spammer', targetId: 42 })
  assert.ok(view.text.includes('Spammer'))
  assert.ok(view.text.includes('🍌'))
  const rows = view.keyboard.inline_keyboard
  assert.strictEqual(rows.length, 4, 'rows: 3 durations + forever + cancel')
  assert.strictEqual(rows[0].length, 3)
  assert.strictEqual(rows[1].length, 3)
  assert.strictEqual(rows[2].length, 1)
  assert.strictEqual(rows[3].length, 1)
})

test('keyboard callbacks encode targetId + seconds', () => {
  const ctx = { i18n: mkI18n('uk') }
  const { keyboard } = picker.renderPicker(ctx, { targetName: 'X', targetId: 123 })
  const all = keyboard.inline_keyboard.flat()
  // 5min = 300 seconds
  const fiveMin = all.find(b => /5\s*хв/.test(b.text))
  assert.ok(fiveMin, 'has 5-min button')
  assert.strictEqual(fiveMin.callback_data, 'm:v1:mod.ban.picker:do:123:300')
  // forever = seconds 0
  const forever = all.find(b => /Назавжди/.test(b.text))
  assert.ok(forever)
  assert.strictEqual(forever.callback_data, 'm:v1:mod.ban.picker:do:123:0')
})

test('callback_data stays within 64 bytes for large negative chat target', () => {
  const ctx = { i18n: mkI18n('uk') }
  // Target IDs are user ids (positive); channels are negative. Use a
  // realistic 12-digit channel id to check the cap.
  const { keyboard } = picker.renderPicker(ctx, { targetName: 'X', targetId: -1001234567890 })
  for (const btn of keyboard.inline_keyboard.flat()) {
    if (btn.callback_data) {
      assert.ok(
        Buffer.byteLength(btn.callback_data, 'utf8') <= 64,
        `callback ${btn.callback_data} (${Buffer.byteLength(btn.callback_data, 'utf8')} bytes)`
      )
    }
  }
})

test('handle: do:<id>:<seconds> → calls performBan with parsed args', async () => {
  let captured = null
  // Stub the banan module via Node's require.cache so the lazy-require
  // inside handle() picks it up.
  const bananPath = require.resolve('../handlers/banan')
  require.cache[bananPath] = {
    id: bananPath,
    filename: bananPath,
    loaded: true,
    exports: {
      performBan: async (_ctx, opts) => {
        captured = opts
        return { ok: true }
      }
    }
  }

  const ctx = {
    i18n: mkI18n('uk'),
    chat: { id: -100 },
    from: { id: 7 },
    telegram: { deleteMessage: async () => {} },
    callbackQuery: { message: { message_id: 500 } }
  }
  const res = await picker.handle(ctx, 'do', ['42', '300'])
  assert.strictEqual(res.render, false)
  assert.ok(res.silent)
  assert.ok(captured)
  assert.strictEqual(captured.targetId, 42)
  assert.strictEqual(captured.seconds, 300)
  assert.strictEqual(captured.deletePickerMessageId, 500)

  delete require.cache[bananPath]
})

test('handle: do:<id>:0 → permanent ban (seconds === 0)', async () => {
  let capturedSeconds = null
  const bananPath = require.resolve('../handlers/banan')
  require.cache[bananPath] = {
    id: bananPath,
    filename: bananPath,
    loaded: true,
    exports: {
      performBan: async (_ctx, opts) => {
        capturedSeconds = opts.seconds
        return { ok: true }
      }
    }
  }

  const ctx = {
    i18n: mkI18n('uk'),
    chat: { id: -100 },
    from: { id: 7 },
    telegram: { deleteMessage: async () => {} },
    callbackQuery: { message: { message_id: 500 } }
  }
  await picker.handle(ctx, 'do', ['42', '0'])
  assert.strictEqual(capturedSeconds, 0, 'permanent encoded as seconds=0')

  delete require.cache[bananPath]
})

test('handle: unknown action → silent, no performBan call', async () => {
  let called = false
  const bananPath = require.resolve('../handlers/banan')
  require.cache[bananPath] = {
    id: bananPath,
    filename: bananPath,
    loaded: true,
    exports: {
      performBan: async () => { called = true; return { ok: true } }
    }
  }

  const ctx = {
    i18n: mkI18n('uk'),
    chat: { id: -100 },
    from: { id: 7 },
    callbackQuery: { message: { message_id: 1 } }
  }
  const res = await picker.handle(ctx, 'nope', [])
  assert.strictEqual(res.render, false)
  assert.ok(res.silent)
  assert.strictEqual(called, false)

  delete require.cache[bananPath]
})

test('handle: bad numeric args → invalid toast', async () => {
  const ctx = {
    i18n: mkI18n('uk'),
    chat: { id: -100 },
    from: { id: 7 },
    callbackQuery: { message: { message_id: 1 } }
  }
  const res = await picker.handle(ctx, 'do', ['not-a-number', '300'])
  assert.strictEqual(res.toast, 'menu.mod.ban.picker.invalid')
})

test('handle: performBan returns failure → surfaces toast', async () => {
  const bananPath = require.resolve('../handlers/banan')
  require.cache[bananPath] = {
    id: bananPath,
    filename: bananPath,
    loaded: true,
    exports: {
      performBan: async () => ({ ok: false, toastKey: 'menu.mod.ban.picker.failed' })
    }
  }
  const ctx = {
    i18n: mkI18n('uk'),
    chat: { id: -100 },
    from: { id: 7 },
    callbackQuery: { message: { message_id: 1 } }
  }
  const res = await picker.handle(ctx, 'do', ['42', '300'])
  assert.strictEqual(res.toast, 'menu.mod.ban.picker.failed')

  delete require.cache[bananPath]
})

test('cancel: cancel button uses reserved _close token (router-handled)', () => {
  const ctx = { i18n: mkI18n('uk') }
  const { keyboard } = picker.renderPicker(ctx, { targetName: 'X', targetId: 1 })
  const cancel = keyboard.inline_keyboard.flat().find(b => /Скасувати/.test(b.text))
  assert.ok(cancel, 'cancel button present')
  assert.strictEqual(cancel.callback_data, 'm:v1:_close')
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + (e.stack || e.message)) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
