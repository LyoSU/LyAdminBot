// Tests for the "Дай мені права" card (§8 of the UX design).
// Covers: missing-perm resolution, card text builder (per action + perms),
// step expansion callback.

const assert = require('assert')
const { createI18n } = require('../bot/i18n')

delete require.cache[require.resolve('../helpers/menu/registry')]
delete require.cache[require.resolve('../helpers/menu/screens/mod-rights')]
delete require.cache[require.resolve('../helpers/bot-permissions')]

const rights = require('../helpers/menu/screens/mod-rights')
const registry = require('../helpers/menu/registry')
const botPermissions = require('../helpers/bot-permissions')

const i18nLoader = createI18n()

const mkI18n = (lang = 'uk') => i18nLoader.createContext(lang)

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('screen registers at id mod.rights with public access', () => {
  try { rights.register() } catch (e) { if (!/already registered/.test(e.message)) throw e }
  const s = registry.getMenu('mod.rights')
  assert.ok(s, 'screen registered')
  assert.strictEqual(s.access, 'public')
})

test('missingPerms: cached record with no rights → all flags missing for action', async () => {
  botPermissions._resetForTests()
  botPermissions.setFromMember(-100, { status: 'member', can_delete_messages: false, can_restrict_members: false })
  const ctx = { telegram: {}, chat: { id: -100 }, botInfo: { id: 999 } }
  const missing = await rights.missingPerms(ctx, 'banan')
  assert.deepStrictEqual(missing, ['can_restrict_members'])
})

test('missingPerms: admin with full rights → nothing missing', async () => {
  botPermissions._resetForTests()
  botPermissions.setFromMember(-100, {
    status: 'administrator',
    can_delete_messages: true,
    can_restrict_members: true
  })
  const ctx = { telegram: {}, chat: { id: -100 }, botInfo: { id: 999 } }
  const missing = await rights.missingPerms(ctx, 'generic')
  assert.deepStrictEqual(missing, [])
})

test('missingPerms: unknown chat (no cache, no API) → assumes all needed missing', async () => {
  botPermissions._resetForTests()
  const ctx = {
    telegram: null, // forces resolve to fail
    chat: { id: -200 },
    botInfo: { id: 999 }
  }
  const missing = await rights.missingPerms(ctx, 'del')
  assert.deepStrictEqual(missing, ['can_delete_messages'])
})

test('buildCardText: banan action + restrict missing → "Не можу замʼютити" + bullet', () => {
  const ctx = { i18n: mkI18n('uk') }
  const text = rights.buildCardText(ctx, {
    action: 'banan',
    targetUser: { first_name: 'Spammer' },
    missing: ['can_restrict_members']
  })
  assert.ok(text.includes('Spammer'))
  assert.ok(text.includes('Не можу замʼютити') || text.includes("Can't"), 'title present')
  assert.ok(text.includes('Банити користувачів') || text.includes('Ban users'), 'perm bullet')
})

test('buildCardText: del action with no target name still renders', () => {
  const ctx = { i18n: mkI18n('uk') }
  const text = rights.buildCardText(ctx, {
    action: 'del',
    targetUser: null,
    missing: ['can_delete_messages']
  })
  assert.ok(text.length > 0)
  assert.ok(text.includes('Видаляти повідомлення'))
})

test('buildCardText: no missing perms → bare title (no bullet block)', () => {
  const ctx = { i18n: mkI18n('uk') }
  const text = rights.buildCardText(ctx, { action: 'banan', targetUser: { first_name: 'X' }, missing: [] })
  assert.ok(!text.includes('•'))
})

test('buildCardKeyboard: two rows — [how], [dismiss]', () => {
  const ctx = { i18n: mkI18n('uk') }
  const kb = rights.buildCardKeyboard(ctx, 'banan')
  assert.strictEqual(kb.inline_keyboard.length, 2)
  assert.ok(/Як дати права|How to grant/.test(kb.inline_keyboard[0][0].text))
  assert.strictEqual(kb.inline_keyboard[1][0].callback_data, 'm:v1:_close')
})

test('buildStepsText: 4 enumerated steps + header', () => {
  const ctx = { i18n: mkI18n('uk') }
  const text = rights.buildStepsText(ctx)
  assert.ok(text.includes('1.'))
  assert.ok(text.includes('2.'))
  assert.ok(text.includes('3.'))
  assert.ok(text.includes('4.'))
  assert.ok(text.includes('Як дати права') || text.includes('How to grant'))
})

test('handle: show action → edits message with steps text', async () => {
  const edits = []
  const ctx = {
    i18n: mkI18n('uk'),
    chat: { id: -100 },
    telegram: {
      callApi: async (method, payload) => {
        if (method === 'editMessageText') { edits.push(payload); return {} }
        return {}
      }
    },
    callbackQuery: { message: { message_id: 5 } },
    db: null
  }
  const res = await rights.handle(ctx, 'show', ['banan'])
  assert.strictEqual(res.render, false)
  assert.ok(res.silent)
  assert.strictEqual(edits.length, 1)
  assert.ok(edits[0].text.includes('1.'))
  // Dismiss/ack button
  assert.strictEqual(edits[0].reply_markup.inline_keyboard[0][0].callback_data, 'm:v1:_close')
})

test('handle: ack action → deletes the message', async () => {
  let deleted = false
  const ctx = {
    i18n: mkI18n('uk'),
    chat: { id: -100 },
    callbackQuery: { message: { message_id: 5 } },
    deleteMessage: async () => { deleted = true }
  }
  const res = await rights.handle(ctx, 'ack', [])
  assert.strictEqual(res.render, false)
  assert.ok(res.silent)
  assert.strictEqual(deleted, true)
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
