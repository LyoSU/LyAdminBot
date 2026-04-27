// Smoke test for bot/setup-commands.js — exercises the API-call shape
// (scope, language_code, command list) and confirms failures are swallowed.

const assert = require('assert')
const { createI18n } = require('../bot/i18n')

const { setupCommands, SCOPES, LOCALES } = require('../bot/setup-commands')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkFakeBot = (failOn = null) => {
  const calls = []
  const i18n = createI18n()
  return {
    context: { i18n },
    telegram: {
      callApi: async (method, payload) => {
        calls.push({ method, payload })
        if (failOn && failOn(method, payload)) {
          const err = new Error('simulated failure')
          throw err
        }
        return true
      }
    },
    _calls: calls
  }
}

test('setupCommands issues setMyCommands for every scope × locale combo', async () => {
  const bot = mkFakeBot()
  await setupCommands(bot)

  const setMy = bot._calls.filter(c => c.method === 'setMyCommands')
  const menuBtn = bot._calls.filter(c => c.method === 'setChatMenuButton')

  // 4 scopes × 5 locales = 20 setMyCommands calls
  assert.strictEqual(setMy.length, Object.keys(SCOPES).length * LOCALES.length,
    `expected ${Object.keys(SCOPES).length * LOCALES.length} setMyCommands, got ${setMy.length}`)

  // Exactly one global menu-button call
  assert.strictEqual(menuBtn.length, 1)
  assert.deepStrictEqual(menuBtn[0].payload, { menu_button: { type: 'commands' } })
})

test('setupCommands passes scope + language_code + well-formed command list', async () => {
  const bot = mkFakeBot()
  await setupCommands(bot)

  const ukAdmin = bot._calls.find(c =>
    c.method === 'setMyCommands' &&
    c.payload.language_code === 'uk' &&
    c.payload.scope.type === 'all_chat_administrators'
  )
  assert.ok(ukAdmin, 'uk × all_chat_administrators call should exist')

  const cmds = ukAdmin.payload.commands
  assert.ok(Array.isArray(cmds) && cmds.length > 0)

  // Admin scope must include /settings; group scope must not.
  const adminNames = cmds.map(c => c.command)
  assert.ok(adminNames.includes('settings'), 'admin scope must include /settings')

  const ukGroup = bot._calls.find(c =>
    c.method === 'setMyCommands' &&
    c.payload.language_code === 'uk' &&
    c.payload.scope.type === 'all_group_chats'
  )
  const groupNames = ukGroup.payload.commands.map(c => c.command)
  assert.ok(!groupNames.includes('settings'), 'group scope must not include /settings')
  assert.ok(groupNames.includes('banan'), 'group scope must include /banan')

  // Descriptions must be non-empty strings from the `bot_commands:` namespace.
  for (const c of cmds) {
    assert.strictEqual(typeof c.command, 'string')
    assert.strictEqual(typeof c.description, 'string')
    assert.ok(c.description.length > 0)
    // Telegram limit on description length (256 chars)
    assert.ok(c.description.length <= 256, `description too long: "${c.description}"`)
  }
})

test('setupCommands swallows Telegram API errors', async () => {
  // Force every setMyCommands call to fail; must not throw.
  const bot = mkFakeBot((method) => method === 'setMyCommands')
  await assert.doesNotReject(setupCommands(bot))

  // setChatMenuButton still runs after the failed setMyCommands batch.
  const menuBtn = bot._calls.filter(c => c.method === 'setChatMenuButton')
  assert.strictEqual(menuBtn.length, 1)
})

test('setupCommands also survives setChatMenuButton failure', async () => {
  const bot = mkFakeBot((method) => method === 'setChatMenuButton')
  await assert.doesNotReject(setupCommands(bot))
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
