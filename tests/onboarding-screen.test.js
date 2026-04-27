const assert = require('assert')
const emojiMap = require('../helpers/emoji-map')
const { createI18n } = require('../bot/i18n')

delete require.cache[require.resolve('../helpers/menu/registry')]
delete require.cache[require.resolve('../helpers/menu/router')]
delete require.cache[require.resolve('../helpers/menu/screens/onboarding')]

const onboarding = require('../helpers/menu/screens/onboarding')
const registry = require('../helpers/menu/registry')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const i18n = createI18n()

const mkCtx = ({ lang = 'uk', threshold = 70, welcomeEnabled = false, chatLocale } = {}) => ({
  i18n: {
    t: (k, vars = {}) => i18n.t(lang, k, { e: emojiMap, ...vars }),
    locale: () => lang
  },
  chat: { id: -100123 },
  group: {
    info: {
      settings: {
        locale: chatLocale || lang,
        openaiSpamCheck: { confidenceThreshold: threshold },
        welcome: { enable: welcomeEnabled }
      }
    }
  },
  from: { id: 11 }
})

test('languageName maps known codes to human labels', () => {
  assert.strictEqual(onboarding.languageName('uk'), 'Українська')
  assert.strictEqual(onboarding.languageName('en'), 'English')
  assert.strictEqual(onboarding.languageName('ru'), 'Русский')
  assert.strictEqual(onboarding.languageName('tr'), 'Türkçe')
  assert.strictEqual(onboarding.languageName('by'), 'Беларуская')
})

test('sensitivityLabel buckets by threshold', () => {
  const ctx = mkCtx()
  assert.strictEqual(onboarding.sensitivityLabel(ctx, 60), ctx.i18n.t('menu.onboarding.sensitivity.low'))
  assert.strictEqual(onboarding.sensitivityLabel(ctx, 70), ctx.i18n.t('menu.onboarding.sensitivity.mid'))
  assert.strictEqual(onboarding.sensitivityLabel(ctx, 85), ctx.i18n.t('menu.onboarding.sensitivity.high'))
})

test('renderView produces card with current settings', () => {
  const ctx = mkCtx({ threshold: 70, welcomeEnabled: false, chatLocale: 'uk' })
  const view = onboarding.renderView(ctx)
  assert.ok(view.text.includes('Українська'))
  assert.ok(view.text.includes('70%'))
  assert.ok(view.text.includes('вимкнено'))
  assert.strictEqual(view.keyboard.inline_keyboard[0].length, 2)
})

test('renderView handles missing settings without crashing', () => {
  const ctx = {
    i18n: { t: (k, vars = {}) => i18n.t('en', k, { e: emojiMap, ...vars }), locale: () => 'en' },
    chat: { id: -1 },
    from: { id: 1 }
  }
  const view = onboarding.renderView(ctx)
  assert.ok(view.text && view.text.length > 0)
})

test('register() adds onboarding.root to the menu registry', () => {
  try { onboarding.register() } catch (e) { if (!/already registered/.test(e.message)) throw e }
  const screen = registry.getMenu('onboarding.root')
  assert.ok(screen)
  assert.strictEqual(screen.access, 'group_admin')
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
