const assert = require('assert')
const emojiMap = require('../helpers/emoji-map')
const { createI18n } = require('../bot/i18n')

// Fresh registry per run.
delete require.cache[require.resolve('../helpers/menu/registry')]
delete require.cache[require.resolve('../helpers/menu/screens/settings-welcome')]

const welcome = require('../helpers/menu/screens/settings-welcome')
const registry = require('../helpers/menu/registry')

const i18nLoader = createI18n()

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = ({
  lang = 'uk',
  enabled = false,
  texts = [],
  gifs = []
} = {}) => ({
  i18n: {
    t: (k, vars = {}) => i18nLoader.t(lang, k, { e: emojiMap, ...vars }),
    locale: () => lang
  },
  chat: { id: -100, type: 'supergroup' },
  from: { id: 1 },
  group: {
    info: {
      settings: {
        welcome: { enable: enabled, texts: texts.slice(), gifs: gifs.slice() }
      },
      save: async () => {}
    }
  }
})

// --- registration ----------------------------------------------------------

test('register() adds all 3 screens with group_admin access', () => {
  try { welcome.register() } catch (e) { if (!/already registered/.test(e.message)) throw e }
  const ids = Object.values(welcome.SCREEN_IDS)
  assert.strictEqual(ids.length, 3)
  for (const id of ids) {
    const s = registry.getMenu(id)
    assert.ok(s, `missing screen ${id}`)
    assert.strictEqual(s.access, 'group_admin')
  }
})

// --- root ------------------------------------------------------------------

test('renderRoot shows enabled/disabled state and counts', () => {
  const ctx = mkCtx({ enabled: true, texts: ['hi %name%'], gifs: ['ABCDEFGHIJKLMNOPQRST'] })
  const view = welcome.renderRoot(ctx)
  assert.ok(view.text.includes('увімкнено'))
  assert.ok(view.text.includes('1'))
})

test('renderRoot toggle button label flips with state', () => {
  const enabled = welcome.renderRoot(mkCtx({ enabled: true }))
  const disabled = welcome.renderRoot(mkCtx({ enabled: false }))
  const flatEn = enabled.keyboard.inline_keyboard.flat().map(b => b.text).join(' ')
  const flatDi = disabled.keyboard.inline_keyboard.flat().map(b => b.text).join(' ')
  assert.ok(flatEn.includes('Вимкнути'))
  assert.ok(flatDi.includes('Увімкнути'))
})

test('root toggle handler flips enable flag', async () => {
  const ctx = mkCtx({ enabled: false })
  const screen = registry.getMenu(welcome.SCREEN_IDS.root)
  await screen.handle(ctx, 'toggle', [])
  assert.strictEqual(ctx.group.info.settings.welcome.enable, true)
  await screen.handle(ctx, 'toggle', [])
  assert.strictEqual(ctx.group.info.settings.welcome.enable, false)
})

test('all root callback_data fits 64 bytes', () => {
  const ctx = mkCtx()
  const view = welcome.renderRoot(ctx)
  for (const b of view.keyboard.inline_keyboard.flat()) {
    if (b.callback_data) {
      assert.ok(Buffer.byteLength(b.callback_data, 'utf8') <= 64,
        `${b.text} exceeds 64 bytes: ${b.callback_data}`)
    }
  }
})

// --- texts -----------------------------------------------------------------

test('renderTexts empty state offers add-first', () => {
  const view = welcome.renderTexts(mkCtx({ texts: [] }))
  const flat = view.keyboard.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text.includes('Додати перший')))
})

test('renderTexts shows preview rows with delete buttons', () => {
  const ctx = mkCtx({ texts: ['Привіт %name%', 'Welcome'] })
  const view = welcome.renderTexts(ctx, { page: 0 })
  assert.ok(view.text.includes('Привіт'))
  assert.ok(view.text.includes('Welcome'))
  const flat = view.keyboard.inline_keyboard.flat()
  const delBtns = flat.filter(b => /🗑/.test(b.text))
  assert.strictEqual(delBtns.length, 2)
})

test('texts del removes by index', async () => {
  const ctx = mkCtx({ texts: ['a', 'b', 'c'] })
  const screen = registry.getMenu(welcome.SCREEN_IDS.texts)
  await screen.handle(ctx, 'del', ['1'])
  assert.deepStrictEqual(ctx.group.info.settings.welcome.texts, ['a', 'c'])
})

test('handleTextInput appends valid input', async () => {
  const ctx = mkCtx({ texts: [] })
  ctx.telegram = { callApi: async () => ({}) }
  await welcome.handleTextInput(ctx, 'Hi there')
  assert.deepStrictEqual(ctx.group.info.settings.welcome.texts, ['Hi there'])
})

test('handleTextInput rejects too-long input', async () => {
  const ctx = mkCtx({ texts: [] })
  ctx.telegram = { callApi: async () => ({}) }
  await welcome.handleTextInput(ctx, 'x'.repeat(welcome.MAX_TEXT_LEN + 1))
  assert.strictEqual(ctx.group.info.settings.welcome.texts.length, 0)
})

test('handleTextInput rejects when at MAX_TEXTS cap', async () => {
  const full = Array.from({ length: welcome.MAX_TEXTS }, (_, i) => `t${i}`)
  const ctx = mkCtx({ texts: full })
  ctx.telegram = { callApi: async () => ({}) }
  await welcome.handleTextInput(ctx, 'overflow')
  assert.strictEqual(ctx.group.info.settings.welcome.texts.length, welcome.MAX_TEXTS)
})

test('text add handler returns limit toast at cap', async () => {
  const full = Array.from({ length: welcome.MAX_TEXTS }, (_, i) => `t${i}`)
  const ctx = mkCtx({ texts: full })
  ctx.telegram = { callApi: async () => ({}) }
  const screen = registry.getMenu(welcome.SCREEN_IDS.texts)
  const result = await screen.handle(ctx, 'add', [])
  assert.strictEqual(result.toast, 'menu.settings.welcome.texts.limit')
})

// --- gifs ------------------------------------------------------------------

test('renderGifs empty state', () => {
  const view = welcome.renderGifs(mkCtx({ gifs: [] }))
  const flat = view.keyboard.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text.includes('Додати перший')))
})

test('renderGifs lists indices, never embeds file_ids', () => {
  const view = welcome.renderGifs(mkCtx({ gifs: ['SECRET_FILE_ID_AAAA_LONG'] }))
  assert.ok(view.text.includes('#1'))
  assert.ok(!view.text.includes('SECRET_FILE_ID_AAAA_LONG'))
})

test('handleGifInput accepts valid file_id-shaped string', async () => {
  const ctx = mkCtx({ gifs: [] })
  ctx.telegram = { callApi: async () => ({}) }
  await welcome.handleGifInput(ctx, 'CAACAgIAAxkBAAEABCEXFakeFileIdString')
  assert.strictEqual(ctx.group.info.settings.welcome.gifs.length, 1)
})

test('handleGifInput rejects garbage', async () => {
  const ctx = mkCtx({ gifs: [] })
  ctx.telegram = { callApi: async () => ({}) }
  await welcome.handleGifInput(ctx, 'short')
  assert.strictEqual(ctx.group.info.settings.welcome.gifs.length, 0)
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
