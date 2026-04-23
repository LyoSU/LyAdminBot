const assert = require('assert')
const path = require('path')
const I18n = require('telegraf-i18n')
const emojiMap = require('../helpers/emoji-map')

delete require.cache[require.resolve('../helpers/menu/registry')]
delete require.cache[require.resolve('../helpers/menu/screens/settings-diagnostics')]

const diag = require('../helpers/menu/screens/settings-diagnostics')
const registry = require('../helpers/menu/registry')

const i18nLoader = new I18n({
  directory: path.resolve(__dirname, '..', 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = ({ lang = 'uk', telegramOk = true, telegramDelay = 50 } = {}) => ({
  i18n: {
    t: (k, vars = {}) => i18nLoader.t(lang, k, { e: emojiMap, ...vars }),
    locale: () => lang
  },
  chat: { id: -100 },
  from: { id: 1 },
  telegram: {
    callApi: async (method) => {
      if (method === 'getMe') {
        await new Promise(resolve => setTimeout(resolve, telegramDelay))
        if (!telegramOk) throw new Error('TG fail')
        return { id: 1, username: 'TestBot' }
      }
      throw new Error('unsupported method')
    }
  }
})

// --- registration ----------------------------------------------------------

test('register() adds settings.diagnostics with group_admin access', () => {
  try { diag.register() } catch (e) { if (!/already registered/.test(e.message)) throw e }
  const s = registry.getMenu(diag.SCREEN_ID)
  assert.ok(s)
  assert.strictEqual(s.access, 'group_admin')
})

// --- pure helpers ----------------------------------------------------------

test('humanUptime formats d/h/m', () => {
  assert.strictEqual(diag.humanUptime(0), '0m')
  assert.strictEqual(diag.humanUptime(60), '1m')
  assert.strictEqual(diag.humanUptime(3600), '1h')
  assert.strictEqual(diag.humanUptime(86400 + 3600 + 60), '1d 1h 1m')
})

test('grade returns 🟢/🟡/🔴 by latency', () => {
  assert.strictEqual(diag.grade(100), '🟢')
  assert.strictEqual(diag.grade(800), '🟡')
  assert.strictEqual(diag.grade(2000), '🔴')
  assert.strictEqual(diag.grade(null), '🔴')
})

test('errClass: extracts a short identifier', () => {
  assert.strictEqual(diag.errClass(new Error('timeout')), 'Timeout')
  assert.strictEqual(diag.errClass({ name: 'TypeError' }), 'TypeError')
  assert.strictEqual(diag.errClass({ message: 'CONN_REFUSED:::full message' }), 'CONN_REFUSED')
})

test('raceTimeout rejects when slow', async () => {
  const slow = new Promise(resolve => setTimeout(resolve, 1000))
  let err = null
  try { await diag.raceTimeout(slow, 50, 'too slow') } catch (e) { err = e }
  assert.ok(err)
  assert.strictEqual(err.message, 'too slow')
})

test('raceTimeout resolves when fast', async () => {
  const fast = Promise.resolve('OK')
  const result = await diag.raceTimeout(fast, 100)
  assert.strictEqual(result, 'OK')
})

// --- individual checks -----------------------------------------------------

test('checkTelegram: 🟢 on fast success', async () => {
  const ctx = mkCtx({ telegramOk: true, telegramDelay: 5 })
  const result = await diag.checkTelegram(ctx)
  assert.strictEqual(result.key, 'telegram')
  assert.strictEqual(result.status, '🟢')
})

test('checkTelegram: 🔴 on error', async () => {
  const ctx = mkCtx({ telegramOk: false })
  const result = await diag.checkTelegram(ctx)
  assert.strictEqual(result.status, '🔴')
})

test('checkOpenAI: 🟡 when no API key set', async () => {
  const before = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  const r = await diag.checkOpenAI()
  assert.strictEqual(r.status, '🟡')
  if (before !== undefined) process.env.OPENAI_API_KEY = before
})

test('checkOpenRouter: 🟡 when no API key set', () => {
  const before = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  const r = diag.checkOpenRouter()
  assert.strictEqual(r.status, '🟡')
  if (before !== undefined) process.env.OPENROUTER_API_KEY = before
})

test('checkQdrant: 🟡 when not configured', async () => {
  const a = process.env.QDRANT_URL
  const b = process.env.QDRANT_API_KEY
  delete process.env.QDRANT_URL
  delete process.env.QDRANT_API_KEY
  const r = await diag.checkQdrant()
  assert.strictEqual(r.status, '🟡')
  if (a !== undefined) process.env.QDRANT_URL = a
  if (b !== undefined) process.env.QDRANT_API_KEY = b
})

test('checkUptime: always 🟢', () => {
  const r = diag.checkUptime()
  assert.strictEqual(r.status, '🟢')
  assert.ok(r.value.length > 0)
})

test('safe wrapper turns thrown errors into 🔴 row', async () => {
  const wrapped = diag.safe(async () => { throw new Error('blow up') })
  const r = await wrapped()
  assert.strictEqual(r.status, '🔴')
})

// --- render ----------------------------------------------------------------

test('render returns text + keyboard, all checks resolve', async () => {
  const ctx = mkCtx({ telegramOk: true, telegramDelay: 5 })
  const view = await diag.render(ctx)
  assert.ok(view.text.includes('Діагностика'))
  // Has at least one row per check + refresh + back
  const flat = view.keyboard.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text.includes('Оновити')))
  assert.ok(flat.some(b => b.text.includes('Назад')))
})

test('render never throws even when a check fails synchronously', async () => {
  const ctx = mkCtx({ telegramOk: false })
  let view = null
  try {
    view = await diag.render(ctx)
  } catch (e) {
    assert.fail('render threw: ' + e.message)
  }
  assert.ok(view.text)
  assert.ok(view.text.includes('🔴'))
})

test('handle refresh action returns render', async () => {
  const result = await diag.handle({}, 'refresh')
  assert.strictEqual(result, 'render')
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
