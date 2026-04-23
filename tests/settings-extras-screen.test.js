const assert = require('assert')
const path = require('path')
const I18n = require('telegraf-i18n')
const emojiMap = require('../helpers/emoji-map')

delete require.cache[require.resolve('../helpers/menu/registry')]
delete require.cache[require.resolve('../helpers/menu/screens/settings-extras')]

const extras = require('../helpers/menu/screens/settings-extras')
const registry = require('../helpers/menu/registry')

const i18nLoader = new I18n({
  directory: path.resolve(__dirname, '..', 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = ({ lang = 'uk', items = [], maxExtra = 10 } = {}) => ({
  i18n: {
    t: (k, vars = {}) => i18nLoader.t(lang, k, { e: emojiMap, ...vars }),
    locale: () => lang
  },
  chat: { id: -100, type: 'supergroup' },
  from: { id: 1 },
  group: {
    info: {
      settings: {
        extras: items.map(name => ({ name, type: 'text', message: { text: 'hi from ' + name } })),
        maxExtra
      },
      save: async () => {}
    }
  }
})

// --- registration ----------------------------------------------------------

test('register() adds root + view screens with group_admin access', () => {
  try { extras.register() } catch (e) { if (!/already registered/.test(e.message)) throw e }
  for (const id of Object.values(extras.SCREEN_IDS)) {
    const s = registry.getMenu(id)
    assert.ok(s)
    assert.strictEqual(s.access, 'group_admin')
  }
})

// --- root grid -------------------------------------------------------------

test('renderRoot empty state offers create CTA', () => {
  const view = extras.renderRoot(mkCtx({ items: [] }))
  const flat = view.keyboard.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text.includes('Створити')))
})

test('renderRoot shows count/max in header', () => {
  const ctx = mkCtx({ items: ['rules', 'faq'], maxExtra: 5 })
  const view = extras.renderRoot(ctx)
  assert.ok(view.text.includes('2'))
  assert.ok(view.text.includes('5'))
})

test('grid lays out 2 columns', () => {
  const ctx = mkCtx({ items: ['a', 'b', 'c', 'd'] })
  const view = extras.renderRoot(ctx)
  // Filter out the trailing 'create' + back rows; check the first row has
  // exactly 2 buttons (the grid rows).
  const gridRows = view.keyboard.inline_keyboard.filter(r => r.length === 2 && r[0].text.startsWith('#'))
  assert.strictEqual(gridRows.length, 2)
})

test('all callback_data fit under 64 bytes (latin)', () => {
  const ctx = mkCtx({ items: ['rules', 'faq', 'links'] })
  const view = extras.renderRoot(ctx)
  for (const b of view.keyboard.inline_keyboard.flat()) {
    if (b.callback_data) {
      assert.ok(Buffer.byteLength(b.callback_data, 'utf8') <= 64)
    }
  }
})

test('pagination row appears above PER_PAGE items', () => {
  const items = Array.from({ length: extras.PER_PAGE + 2 }, (_, i) => `e${i}`)
  const ctx = mkCtx({ items })
  const view = extras.renderRoot(ctx, { page: 0 })
  const navRow = view.keyboard.inline_keyboard.find(r =>
    r.length === 3 && r[1] && /\d+ \/ \d+/.test(r[1].text)
  )
  assert.ok(navRow, 'expected a 3-button pagination row')
})

test('create button → toast (cue_toast)', async () => {
  const ctx = mkCtx({ items: [] })
  const screen = registry.getMenu(extras.SCREEN_IDS.root)
  const result = await screen.handle(ctx, 'create', [])
  assert.strictEqual(result.toast, 'menu.empty_state.extras.cue_toast')
})

// --- view ------------------------------------------------------------------

test('renderView shows name, type, preview', () => {
  const ctx = mkCtx({ items: ['rules'] })
  const view = extras.renderView(ctx, { slug: 'rules' })
  assert.ok(view.text.includes('rules'))
  assert.ok(view.text.includes('текст'))
  assert.ok(view.text.includes('hi from rules'))
})

test('renderView falls back to grid when slug is unknown', () => {
  const ctx = mkCtx({ items: ['rules'] })
  const view = extras.renderView(ctx, { slug: 'doesnotexist' })
  // Falls through to renderRoot; should show count
  assert.ok(view.text.includes('1'))
})

test('view delete confirm → del_ok removes', async () => {
  const ctx = mkCtx({ items: ['rules', 'faq'] })
  ctx.callbackQuery = { message: { message_id: 5 } }
  ctx.telegram = { callApi: async () => ({ message_id: 5 }) }
  const screen = registry.getMenu(extras.SCREEN_IDS.view)
  await screen.handle(ctx, 'del_ok', ['faq'])
  assert.strictEqual(ctx.group.info.settings.extras.length, 1)
  assert.strictEqual(ctx.group.info.settings.extras[0].name, 'rules')
})

test('rename input rejects bad regex', async () => {
  const ctx = mkCtx({ items: ['rules'] })
  ctx.telegram = { callApi: async () => ({}) }
  await extras.handleRenameInput(ctx, 'has spaces!', { data: { slug: 'rules' } })
  // Should NOT have renamed
  assert.strictEqual(ctx.group.info.settings.extras[0].name, 'rules')
})

test('rename input rejects too-long names', async () => {
  const ctx = mkCtx({ items: ['rules'] })
  ctx.telegram = { callApi: async () => ({}) }
  await extras.handleRenameInput(ctx, 'x'.repeat(extras.MAX_NAME_LEN + 1), { data: { slug: 'rules' } })
  assert.strictEqual(ctx.group.info.settings.extras[0].name, 'rules')
})

test('rename input rejects collisions (case-insensitive)', async () => {
  const ctx = mkCtx({ items: ['rules', 'faq'] })
  ctx.telegram = { callApi: async () => ({}) }
  await extras.handleRenameInput(ctx, 'FAQ', { data: { slug: 'rules' } })
  assert.strictEqual(ctx.group.info.settings.extras[0].name, 'rules')
})

test('rename input accepts valid new name', async () => {
  const ctx = mkCtx({ items: ['rules', 'faq'] })
  ctx.telegram = { callApi: async () => ({}) }
  await extras.handleRenameInput(ctx, 'правила', { data: { slug: 'rules' } })
  assert.strictEqual(ctx.group.info.settings.extras[0].name, 'правила')
})

// --- pure helpers ----------------------------------------------------------

test('slugify lowercases + strips invalid chars', () => {
  assert.strictEqual(extras.slugify('Rules!'), 'rules')
  assert.strictEqual(extras.slugify('FAQ #1'), 'faq1')
})

test('describeType returns localized for known types', () => {
  const ctx = mkCtx()
  assert.strictEqual(extras.describeType(ctx, { type: 'photo' }), 'фото')
  assert.strictEqual(extras.describeType(ctx, { type: 'unknown' }), 'unknown')
})

test('extractPreview returns truncated text/caption or empty', () => {
  assert.strictEqual(extras.extractPreview({ message: { text: 'short' } }), 'short')
  const long = extras.extractPreview({ message: { text: 'x'.repeat(500) } })
  assert.ok(long.endsWith('…'))
  assert.ok(long.length <= 121)
  assert.strictEqual(extras.extractPreview({ message: {} }), '')
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
