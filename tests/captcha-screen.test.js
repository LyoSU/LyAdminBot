const assert = require('assert')
const captchaScreen = require('../helpers/menu/screens/captcha')
const { createI18n } = require('../bot/i18n')

const i18nLoader = createI18n()

const mkI18n = (lang = 'uk') => i18nLoader.createContext(lang)

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkRow = (overrides = {}) => ({
  challengeId: 'abc123def456',
  userId: 42,
  chatId: -100500,
  kind: 'mid_confidence',
  correctEmoji: '🍌',
  correctNameKey: 'captcha.emoji.banana',
  attemptsLeft: 3,
  expiresAt: new Date(Date.now() + 60000),
  options: [
    { emoji: '🍌', nameKey: 'captcha.emoji.banana' },
    { emoji: '🍎', nameKey: 'captcha.emoji.apple' },
    { emoji: '🐶', nameKey: 'captcha.emoji.dog' },
    { emoji: '🐱', nameKey: 'captcha.emoji.cat' },
    { emoji: '☀️', nameKey: 'captcha.emoji.sun' },
    { emoji: '🌙', nameKey: 'captcha.emoji.moon' }
  ],
  save: async () => {},
  ...overrides
})

test('buildPromptText renders localized noun', () => {
  const text = captchaScreen.buildPromptText({ i18n: mkI18n('uk') }, mkRow())
  assert.ok(text.includes('банан'), 'uk noun for banana expected')
  assert.ok(text.includes('3'), 'tries-left count expected')
})

test('buildKeyboard renders 2x3 grid of emoji buttons', () => {
  const kb = captchaScreen.buildKeyboard(mkRow())
  assert.strictEqual(kb.inline_keyboard.length, 2)
  assert.strictEqual(kb.inline_keyboard[0].length, 3)
  assert.strictEqual(kb.inline_keyboard[1].length, 3)
  const labels = kb.inline_keyboard.flat().map(b => b.text)
  assert.deepStrictEqual(
    labels.sort(),
    ['🍌', '🍎', '🐶', '🐱', '☀️', '🌙'].sort()
  )
})

test('buildKeyboard callback_data within 64-byte budget', () => {
  const kb = captchaScreen.buildKeyboard(mkRow())
  for (const row of kb.inline_keyboard) {
    for (const b of row) {
      const bytes = Buffer.byteLength(b.callback_data, 'utf8')
      assert.ok(bytes <= 64, 'callback_data overflows 64B: ' + bytes + ' ' + b.callback_data)
    }
  }
})

// Build a ctx with a fake db + telegram so we can exercise handle() without
// the real Mongoose / Bot API. The screen imports captcha-flow which in turn
// reaches out to message-cleanup and logger — ensure they coexist by
// stubbing minimally and leaving the real side-effect-free paths alone.
const mkCtx = (overrides = {}) => {
  const calls = { edits: [], replies: [], cb: [] }
  const i18n = mkI18n('uk')
  const captchaRow = mkRow(overrides.rowOverrides || {})
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: 'private' },
    callbackQuery: { message: { message_id: 99 } },
    i18n,
    session: { userInfo: { telegram_id: 42 } },
    botInfo: { id: 7, username: 'TestBot' },
    telegram: {
      callApi: async (method, payload) => {
        if (method === 'editMessageText') calls.edits.push(payload)
        if (method === 'sendMessage') calls.replies.push(payload)
        if (method === 'answerCallbackQuery') calls.cb.push(payload)
        if (method === 'deleteMessage') return true
        return { message_id: 200 }
      },
      restrictChatMember: async () => true,
      deleteMessage: async () => true,
      getChatMember: async () => ({ status: 'member' })
    },
    db: {
      Captcha: {
        findOne: async (q) => (q.challengeId === captchaRow.challengeId ? captchaRow : null),
        findOneAndDelete: async () => captchaRow,
        consume: async () => captchaRow
      },
      ModEvent: {
        findOne: async () => null,
        findOneAndUpdate: async () => null,
        create: async (x) => ({ ...x, eventId: 'eeeeee000000' })
      },
      ModLog: {
        create: async () => ({})
      },
      User: {
        updateOne: async () => ({}),
        findOneAndUpdate: async () => ({})
      },
      ScheduledDeletion: {
        findOneAndUpdate: async () => ({}),
        create: async () => ({}),
        deleteOne: async () => ({}),
        schedule: async () => ({})
      }
    },
    _calls: calls
  }
  return { ctx, captchaRow, calls }
}

test('pick wrong emoji re-renders prompt + toast', async () => {
  const { ctx } = mkCtx()
  const result = await captchaScreen.handle(ctx, 'pick', ['abc123def456', '🍎'])
  assert.strictEqual(result.toast, 'captcha.toast.wrong')
  assert.strictEqual(ctx._calls.edits.length, 1, 'edited the prompt on wrong pick')
})

test('expired challenge yields expired toast', async () => {
  const { ctx } = mkCtx({ rowOverrides: { expiresAt: new Date(Date.now() - 1000) } })
  const result = await captchaScreen.handle(ctx, 'pick', ['abc123def456', '🍌'])
  assert.strictEqual(result.toast, 'captcha.toast.expired')
})

test('unknown challenge yields expired toast', async () => {
  const { ctx } = mkCtx()
  const result = await captchaScreen.handle(ctx, 'pick', ['doesnotexist', '🍌'])
  assert.strictEqual(result.toast, 'captcha.toast.expired')
})

test('foreign-user pick rejected', async () => {
  const { ctx } = mkCtx()
  ctx.from.id = 999
  const result = await captchaScreen.handle(ctx, 'pick', ['abc123def456', '🍌'])
  assert.strictEqual(result.toast, 'captcha.toast.no_challenge')
})

test('correct pick edits to passed message', async () => {
  const { ctx } = mkCtx({ rowOverrides: { kind: 'global_ban_appeal', chatId: null } })
  ctx.session.userInfo.isGlobalBanned = true
  await captchaScreen.handle(ctx, 'pick', ['abc123def456', '🍌'])
  assert.ok(ctx._calls.edits.length >= 1, 'should edit the prompt message')
  const last = ctx._calls.edits[ctx._calls.edits.length - 1]
  assert.ok(last.text.includes('✓'), 'final edit should carry the pass marker')
  assert.strictEqual(ctx.session.userInfo.isGlobalBanned, false)
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.stack) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
