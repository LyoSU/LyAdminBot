const assert = require('assert')
const path = require('path')
const I18n = require('telegraf-i18n')
const emojiMap = require('../helpers/emoji-map')

// Fresh registry for this file so screen collisions from other tests don't
// leak in.
delete require.cache[require.resolve('../helpers/menu/registry')]
delete require.cache[require.resolve('../helpers/menu/router')]
delete require.cache[require.resolve('../helpers/menu/screens/help')]

const help = require('../helpers/menu/screens/help')
const registry = require('../helpers/menu/registry')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const i18n = new I18n({
  directory: path.resolve(__dirname, '..', 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

const mkCtx = (lang = 'uk') => ({
  i18n: {
    t: (k, vars = {}) => i18n.t(lang, k, { e: emojiMap, ...vars }),
    locale: () => lang
  },
  from: { id: 12345 }
})

test('renderText for each tab produces non-empty text with title', () => {
  const ctx = mkCtx('uk')
  for (const tab of help.TABS) {
    const text = help.renderText(ctx, tab)
    assert.ok(text && text.length > 0, `${tab} body empty`)
    // Must include the common title prefix
    assert.ok(text.includes('LyAdminBot'), `${tab} missing title`)
  }
})

test('buildKeyboardI18n marks the active tab with ● prefix', () => {
  const ctx = mkCtx('uk')
  const kb = help.buildKeyboardI18n(ctx, 'mod', 9999)
  const flat = kb.inline_keyboard.flat()
  const activeBtn = flat.find(b => b.text.startsWith('● '))
  assert.ok(activeBtn, 'an active tab should exist')
  assert.ok(activeBtn.text.includes('Модерація'), 'active tab label matches mod')
  // Only one active
  const actives = flat.filter(b => b.text.startsWith('● '))
  assert.strictEqual(actives.length, 1)
})

test('help.register registers screen at id help.root', () => {
  // May already be registered by a prior require; tolerate.
  try { help.register() } catch (e) { if (!/already registered/.test(e.message)) throw e }
  const screen = registry.getMenu('help.root')
  assert.ok(screen)
  assert.strictEqual(screen.access, 'initiator')
})

test('help.root accessOpts extracts initiator from callback args', () => {
  const screen = registry.getMenu('help.root')
  const ctx = {
    callbackQuery: { data: 'm:v1:help.root:tab:mod:77777' }
  }
  const opts = screen.accessOpts(ctx)
  assert.deepStrictEqual(opts, { initiatorId: 77777 })
})

test('callback_data for each tab button stays under 64 bytes', () => {
  const ctx = mkCtx('uk')
  const kb = help.buildKeyboardI18n(ctx, 'start', 9999999999)
  for (const btn of kb.inline_keyboard.flat()) {
    assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64,
      `${btn.text} callback_data too long: ${btn.callback_data}`)
  }
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
