const assert = require('assert')
const emojiMap = require('../helpers/emoji-map')
const { createI18n } = require('../bot/i18n')

delete require.cache[require.resolve('../helpers/menu/registry')]
delete require.cache[require.resolve('../helpers/menu/screens/settings-modlog')]

const modlog = require('../helpers/menu/screens/settings-modlog')
const registry = require('../helpers/menu/registry')

const i18nLoader = createI18n()

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = ({ lang = 'uk', entries = [], total = null } = {}) => ({
  i18n: {
    t: (k, vars = {}) => i18nLoader.t(lang, k, { e: emojiMap, ...vars }),
    locale: () => lang
  },
  chat: { id: -100, type: 'supergroup' },
  from: { id: 1 },
  db: {
    ModLog: {
      countDocuments: async () => total !== null ? total : entries.length,
      find () {
        return {
          sort () { return this },
          skip () { return this },
          limit () { return this },
          lean: async () => entries
        }
      }
    }
  }
})

const mkEntry = (overrides = {}) => Object.assign({
  chatId: -100,
  eventType: 'manual_ban',
  actorId: 1,
  actorName: 'Admin',
  targetId: 2,
  targetName: 'Spammer',
  action: '5m',
  reason: null,
  timestamp: new Date('2026-04-22T15:42:00Z')
}, overrides)

// --- registration ----------------------------------------------------------

test('register() adds settings.modlog with group_admin access', () => {
  try { modlog.register() } catch (e) { if (!/already registered/.test(e.message)) throw e }
  const s = registry.getMenu(modlog.SCREEN_ID)
  assert.ok(s)
  assert.strictEqual(s.access, 'group_admin')
})

// --- pure helpers ----------------------------------------------------------

test('formatTime returns HH:MM', () => {
  assert.strictEqual(modlog.formatTime(new Date('2026-01-01T15:42:00')), '15:42')
})

test('formatTime handles invalid input', () => {
  assert.strictEqual(modlog.formatTime('not a date'), '??:??')
})

test('renderRow includes time, emoji, body', () => {
  const ctx = mkCtx()
  const row = modlog.renderRow(ctx, mkEntry())
  assert.ok(/\d\d:\d\d/.test(row), 'has HH:MM')
  assert.ok(row.includes('⚔️'), 'has emoji for manual_ban')
  assert.ok(row.includes('Admin'))
  assert.ok(row.includes('Spammer'))
})

test('renderRow escapes HTML in names', () => {
  const ctx = mkCtx()
  const row = modlog.renderRow(ctx, mkEntry({
    actorName: 'Bad<Admin>',
    targetName: 'Bad<Target>'
  }))
  assert.ok(!row.includes('<Admin>'))
  assert.ok(row.includes('&lt;Admin&gt;'))
})

test('renderRow falls back to default for unknown eventType', () => {
  const ctx = mkCtx()
  const row = modlog.renderRow(ctx, mkEntry({ eventType: 'never_heard_of_it' }))
  assert.ok(row.includes('•'), 'unknown type uses bullet emoji')
})

// --- render ----------------------------------------------------------------

test('render shows empty state when no entries', async () => {
  const ctx = mkCtx({ entries: [], total: 0 })
  const view = await modlog.render(ctx, { range: '24h' })
  assert.ok(view.text.includes('Журнал'))
  // Range row + back row
  const flat = view.keyboard.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text.includes('24 год') || b.text.includes('● 24 год')))
  assert.ok(flat.some(b => /Назад/.test(b.text)))
})

test('render lists entries with range header', async () => {
  const entries = [
    mkEntry({ timestamp: new Date('2026-04-22T15:42:00Z') }),
    mkEntry({ eventType: 'auto_ban', actorName: null, timestamp: new Date('2026-04-22T15:30:00Z') })
  ]
  const ctx = mkCtx({ entries, total: 2 })
  const view = await modlog.render(ctx, { range: '24h' })
  assert.ok(view.text.includes('2'), 'shows total count')
  assert.ok(view.text.includes('⚔️'))
  assert.ok(view.text.includes('🤖'))
})

test('render active range marker on range button', async () => {
  const ctx = mkCtx({ entries: [], total: 0 })
  const view = await modlog.render(ctx, { range: '7d' })
  const flat = view.keyboard.inline_keyboard.flat()
  const active = flat.find(b => b.text.startsWith('● '))
  assert.ok(active)
  assert.ok(active.text.includes('7 днів'))
})

test('pagination row absent when total ≤ PAGE_SIZE', async () => {
  const ctx = mkCtx({ entries: [mkEntry()], total: 1 })
  const view = await modlog.render(ctx, { range: '24h' })
  const navRow = view.keyboard.inline_keyboard.find(r =>
    r.length === 3 && /\d+ \/ \d+/.test(r[1].text)
  )
  assert.strictEqual(navRow, undefined)
})

test('pagination row present when total > PAGE_SIZE', async () => {
  const entries = Array(modlog.PAGE_SIZE).fill(0).map((_, i) =>
    mkEntry({ targetName: 'u' + i, timestamp: new Date(Date.now() - i * 1000) })
  )
  const ctx = mkCtx({ entries, total: modlog.PAGE_SIZE * 2 })
  const view = await modlog.render(ctx, { range: '24h', page: 0 })
  const navRow = view.keyboard.inline_keyboard.find(r =>
    r.length === 3 && /\d+ \/ \d+/.test(r[1].text)
  )
  assert.ok(navRow, 'pagination row present')
  assert.ok(/1 \/ 2/.test(navRow[1].text))
})

test('render handles DB errors gracefully (falls back to empty)', async () => {
  const ctx = {
    i18n: { t: (k, v = {}) => i18nLoader.t('uk', k, { e: emojiMap, ...v }), locale: () => 'uk' },
    chat: { id: -100 },
    from: { id: 1 },
    db: {
      ModLog: {
        countDocuments: async () => { throw new Error('fail') },
        find () { return { sort () { return this }, skip () { return this }, limit () { return this }, lean: async () => { throw new Error('fail') } } }
      }
    }
  }
  const view = await modlog.render(ctx, { range: '24h' })
  assert.ok(view.text.length > 0)
  assert.ok(view.keyboard.inline_keyboard.length >= 1)
})

// --- handle ----------------------------------------------------------------

test('handle range action returns state with that range', async () => {
  const result = await modlog.handle({}, 'range', ['7d'])
  assert.deepStrictEqual(result, { render: true, state: { range: '7d', page: 0 } })
})

test('handle range action ignores unknown ranges', async () => {
  const result = await modlog.handle({}, 'range', ['nope'])
  assert.deepStrictEqual(result, { render: false })
})

test('handle page action returns state with that page', async () => {
  const result = await modlog.handle({}, 'page', ['3', '7d'])
  assert.deepStrictEqual(result, { render: true, state: { page: 3, range: '7d' } })
})

test('handle page action without range falls back to default', async () => {
  const result = await modlog.handle({}, 'page', ['2'])
  assert.deepStrictEqual(result, { render: true, state: { page: 2, range: '24h' } })
})

test('handle page action ignores negative or NaN', async () => {
  assert.deepStrictEqual(await modlog.handle({}, 'page', ['-1']), { render: false })
  assert.deepStrictEqual(await modlog.handle({}, 'page', ['abc']), { render: false })
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
