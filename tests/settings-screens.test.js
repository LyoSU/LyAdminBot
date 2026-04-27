const assert = require('assert')
const emojiMap = require('../helpers/emoji-map')
const { createI18n } = require('../bot/i18n')

// Fresh registry per run so we don't collide with other screen tests.
delete require.cache[require.resolve('../helpers/menu/registry')]
delete require.cache[require.resolve('../helpers/menu/router')]
delete require.cache[require.resolve('../helpers/menu/screens/settings')]

const settings = require('../helpers/menu/screens/settings')
const registry = require('../helpers/menu/registry')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const i18n = createI18n()

const mkCtx = ({
  lang = 'uk',
  locale = 'uk',
  enabled = true,
  globalBan = true,
  threshold = 70,
  rules = [],
  trusted = [],
  banDatabase = true,
  banChannel = false,
  welcomeEnabled = false,
  welcomeTexts = [],
  welcomeGifs = [],
  extras = [],
  maxExtra = 3
} = {}) => ({
  i18n: {
    t: (k, vars = {}) => i18n.t(lang, k, { e: emojiMap, ...vars }),
    locale: () => lang
  },
  chat: { id: -100, type: 'supergroup' },
  from: { id: 1 },
  group: {
    info: {
      settings: {
        locale,
        openaiSpamCheck: {
          enabled,
          globalBan,
          confidenceThreshold: threshold,
          customRules: rules,
          trustedUsers: trusted
        },
        banDatabase,
        banChannel,
        welcome: { enable: welcomeEnabled, texts: welcomeTexts, gifs: welcomeGifs },
        extras,
        maxExtra
      },
      save: async () => {}
    }
  }
})

// ----------------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------------

test('register() adds all settings.* screens to the registry', () => {
  try { settings.register() } catch (e) { if (!/already registered/.test(e.message)) throw e }
  const expected = Object.values(settings.SCREEN_IDS)
  for (const id of expected) {
    const s = registry.getMenu(id)
    assert.ok(s, `missing screen ${id}`)
    assert.strictEqual(s.access, 'group_admin', `${id} must be group_admin`)
  }
})

// ----------------------------------------------------------------------------
// Root
// ----------------------------------------------------------------------------

test('settings.root renders with dynamic values', () => {
  const ctx = mkCtx({ threshold: 80, rules: ['ALLOW: foo'], welcomeEnabled: true })
  const view = settings.renderRoot(ctx)
  assert.ok(view.text.includes('80%'))
  assert.ok(view.text.includes('Українська'))
  // Antispam is enabled → "увімкнено" appears
  assert.ok(view.text.includes('увімкнено'))
})

test('settings.root keyboard has 6 rows (per spec §5)', () => {
  const ctx = mkCtx()
  const view = settings.renderRoot(ctx)
  assert.strictEqual(view.keyboard.inline_keyboard.length, 6)
})

test('all callback_data on settings.root fit under 64 bytes', () => {
  const ctx = mkCtx()
  const view = settings.renderRoot(ctx)
  for (const btn of view.keyboard.inline_keyboard.flat()) {
    if (btn.callback_data) {
      assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64,
        `${btn.text} callback_data too long: ${btn.callback_data}`)
    }
  }
})

// ----------------------------------------------------------------------------
// Antispam
// ----------------------------------------------------------------------------

test('renderAntispam shows threshold, bar, counts', () => {
  const ctx = mkCtx({ threshold: 85, rules: ['ALLOW: a', 'DENY: b'], trusted: [1, 2, 3] })
  const view = settings.renderAntispam(ctx)
  assert.ok(view.text.includes('85%'))
  // Contains a bar (▮ or ▱)
  assert.ok(view.text.includes('▮') || view.text.includes('▱'))
  assert.ok(view.text.includes('3'), 'trusted count shown')
})

test('renderAntispam shows Enable button when disabled', () => {
  const ctx = mkCtx({ enabled: false })
  const view = settings.renderAntispam(ctx)
  const flat = view.keyboard.inline_keyboard.flat()
  const hasEnable = flat.some(b => b.text.includes('Увімкнути'))
  assert.ok(hasEnable)
})

// ----------------------------------------------------------------------------
// Sensitivity
// ----------------------------------------------------------------------------

test('clampThreshold clamps to [50..95]', () => {
  assert.strictEqual(settings.clampThreshold(30), 50)
  assert.strictEqual(settings.clampThreshold(100), 95)
  assert.strictEqual(settings.clampThreshold(70), 70)
  assert.strictEqual(settings.clampThreshold('abc'), 70) // NaN → default
})

test('renderSensitivity shows current value and bar', () => {
  const ctx = mkCtx({ threshold: 75 })
  const view = settings.renderSensitivity(ctx)
  assert.ok(view.text.includes('75%'))
  const flat = view.keyboard.inline_keyboard.flat()
  const deltas = flat.filter(b => /−5|−1|\+1|\+5/.test(b.text))
  assert.strictEqual(deltas.length, 4)
})

// ----------------------------------------------------------------------------
// Rules
// ----------------------------------------------------------------------------

test('renderRules shows empty state when list is empty', () => {
  const ctx = mkCtx({ rules: [] })
  const view = settings.renderRules(ctx, { page: 0 })
  assert.ok(view.text.includes('Правил')) // empty-state title in UK
  const flat = view.keyboard.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text.includes('Додати перше')))
})

test('renderRules lists rules with correct type markers', () => {
  const ctx = mkCtx({ rules: ['ALLOW: foo', 'DENY: bar'] })
  const view = settings.renderRules(ctx, { page: 0 })
  assert.ok(view.text.includes('foo'))
  assert.ok(view.text.includes('bar'))
  assert.ok(view.text.includes('✅'))
  assert.ok(view.text.includes('⛔'))
})

test('ruleType / ruleBody parse correctly', () => {
  assert.strictEqual(settings.ruleType('ALLOW: x'), 'allow')
  assert.strictEqual(settings.ruleType('DENY: x'), 'deny')
  assert.strictEqual(settings.ruleType('raw string'), 'deny') // fallback
  assert.strictEqual(settings.ruleBody('ALLOW: hello'), 'hello')
  assert.strictEqual(settings.ruleBody('DENY: bye bye'), 'bye bye')
})

// ----------------------------------------------------------------------------
// Trusted
// ----------------------------------------------------------------------------

test('renderTrusted shows empty state when no trusted users', () => {
  const ctx = mkCtx({ trusted: [] })
  const view = settings.renderTrusted(ctx, { page: 0 })
  const flat = view.keyboard.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text.includes('Додати першого')))
})

test('renderTrusted lists users by id', () => {
  const ctx = mkCtx({ trusted: [111, 222] })
  const view = settings.renderTrusted(ctx, { page: 0 })
  assert.ok(view.text.includes('111'))
  assert.ok(view.text.includes('222'))
})

// ----------------------------------------------------------------------------
// Lang
// ----------------------------------------------------------------------------

test('renderLang lists 5 languages with active marker', () => {
  const ctx = mkCtx({ locale: 'uk' })
  const view = settings.renderLang(ctx)
  const rows = view.keyboard.inline_keyboard
  // 5 language rows + 1 back row
  assert.strictEqual(rows.length, 6)
  const flat = rows.flat()
  const activeMarked = flat.filter(b => b.text.startsWith('● '))
  assert.strictEqual(activeMarked.length, 1)
  assert.ok(activeMarked[0].text.includes('Українська'))
})

test('renderLang uses text names (no country flags)', () => {
  const ctx = mkCtx({ locale: 'en' })
  const view = settings.renderLang(ctx)
  const flat = view.keyboard.inline_keyboard.flat()
  for (const b of flat) {
    // No flag emoji / regional indicators
    assert.ok(!/[\u{1F1E6}-\u{1F1FF}]{2}/u.test(b.text), `flag found in: ${b.text}`)
  }
})

// ----------------------------------------------------------------------------
// Reset
// ----------------------------------------------------------------------------

test('renderReset has confirm + back buttons', () => {
  const ctx = mkCtx()
  const view = settings.renderReset(ctx)
  const flat = view.keyboard.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text.includes('скинути') || b.text.includes('Так')))
  assert.ok(flat.some(b => b.text.includes('Назад')))
})

// ----------------------------------------------------------------------------
// Toggle handlers (stub ctx.group.info.save)
// ----------------------------------------------------------------------------

test('antispam toggle flips enabled flag', async () => {
  const ctx = mkCtx({ enabled: true })
  const screen = registry.getMenu(settings.SCREEN_IDS.antispam)
  await screen.handle(ctx, 'toggle', [])
  assert.strictEqual(ctx.group.info.settings.openaiSpamCheck.enabled, false)
  await screen.handle(ctx, 'toggle', [])
  assert.strictEqual(ctx.group.info.settings.openaiSpamCheck.enabled, true)
})

test('banDatabase toggle flips the flag', async () => {
  const ctx = mkCtx({ banDatabase: true })
  const screen = registry.getMenu(settings.SCREEN_IDS.banDatabase)
  await screen.handle(ctx, 'toggle', [])
  assert.strictEqual(ctx.group.info.settings.banDatabase, false)
  await screen.handle(ctx, 'toggle', [])
  assert.strictEqual(ctx.group.info.settings.banDatabase, true)
})

test('banChannel toggle flips the flag', async () => {
  const ctx = mkCtx({ banChannel: false })
  const screen = registry.getMenu(settings.SCREEN_IDS.banChannel)
  await screen.handle(ctx, 'toggle', [])
  assert.strictEqual(ctx.group.info.settings.banChannel, true)
  await screen.handle(ctx, 'toggle', [])
  assert.strictEqual(ctx.group.info.settings.banChannel, false)
})

test('sensitivity delta updates threshold and clamps', async () => {
  const ctx = mkCtx({ threshold: 90 })
  const screen = registry.getMenu(settings.SCREEN_IDS.sensitivity)
  await screen.handle(ctx, 'delta', ['5'])
  assert.strictEqual(ctx.group.info.settings.openaiSpamCheck.confidenceThreshold, 95) // clamped
  await screen.handle(ctx, 'delta', ['-1'])
  assert.strictEqual(ctx.group.info.settings.openaiSpamCheck.confidenceThreshold, 94)
  await screen.handle(ctx, 'delta', ['-100'])
  assert.strictEqual(ctx.group.info.settings.openaiSpamCheck.confidenceThreshold, 50) // clamped low
})

test('rules del removes by index', async () => {
  const ctx = mkCtx({ rules: ['ALLOW: a', 'DENY: b', 'ALLOW: c'] })
  const screen = registry.getMenu(settings.SCREEN_IDS.rules)
  await screen.handle(ctx, 'del', ['1'])
  assert.deepStrictEqual(ctx.group.info.settings.openaiSpamCheck.customRules, ['ALLOW: a', 'ALLOW: c'])
})

test('trusted del removes by index', async () => {
  const ctx = mkCtx({ trusted: [111, 222, 333] })
  const screen = registry.getMenu(settings.SCREEN_IDS.trusted)
  await screen.handle(ctx, 'del', ['0'])
  assert.deepStrictEqual(ctx.group.info.settings.openaiSpamCheck.trustedUsers, [222, 333])
})

test('lang set updates locale and returns saved toast', async () => {
  const ctx = mkCtx({ locale: 'uk' })
  const screen = registry.getMenu(settings.SCREEN_IDS.lang)
  const result = await screen.handle(ctx, 'set', ['en'])
  assert.strictEqual(ctx.group.info.settings.locale, 'en')
  assert.strictEqual(result.toast, 'menu.settings.lang.saved')
})

test('rules input handler appends with ALLOW/DENY prefix', async () => {
  const replies = []
  const ctx = mkCtx({ rules: [] })
  ctx.chat = { id: -100, type: 'supergroup' }
  ctx.telegram = { callApi: async (method, payload) => { replies.push({ method, payload }); return {} } }

  const allow = settings.handleRuleInput('allow')
  await allow(ctx, 'продаж курсів')
  assert.strictEqual(ctx.group.info.settings.openaiSpamCheck.customRules.length, 1)
  assert.ok(ctx.group.info.settings.openaiSpamCheck.customRules[0].startsWith('ALLOW: '))

  const deny = settings.handleRuleInput('deny')
  await deny(ctx, 'реклама')
  assert.strictEqual(ctx.group.info.settings.openaiSpamCheck.customRules.length, 2)
  assert.ok(ctx.group.info.settings.openaiSpamCheck.customRules[1].startsWith('DENY: '))
})

test('rules input handler rejects too-long input', async () => {
  const replies = []
  const ctx = mkCtx({ rules: [] })
  ctx.chat = { id: -100, type: 'supergroup' }
  ctx.telegram = { callApi: async (method, payload) => { replies.push({ method, payload }); return {} } }

  const allow = settings.handleRuleInput('allow')
  await allow(ctx, 'x'.repeat(300))
  assert.strictEqual(ctx.group.info.settings.openaiSpamCheck.customRules.length, 0)
})

test('trusted input handler parses numeric id', async () => {
  const replies = []
  const ctx = mkCtx({ trusted: [] })
  ctx.chat = { id: -100, type: 'supergroup' }
  ctx.telegram = { callApi: async (method, payload) => { replies.push({ method, payload }); return {} } }

  await settings.handleTrustedInput(ctx, '42')
  assert.deepStrictEqual(ctx.group.info.settings.openaiSpamCheck.trustedUsers, [42])
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
