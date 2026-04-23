const assert = require('assert')
const path = require('path')
const I18n = require('telegraf-i18n')
const emojiMap = require('../helpers/emoji-map')

// Fresh registry + screen per run
delete require.cache[require.resolve('../helpers/menu/registry')]
delete require.cache[require.resolve('../helpers/menu/screens/mod-event')]

const screen = require('../helpers/menu/screens/mod-event')
const registry = require('../helpers/menu/registry')

const i18nLoader = new I18n({
  directory: path.resolve(__dirname, '..', 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

const mkI18n = (lang = 'uk') => ({
  t: (k, vars = {}) => i18nLoader.t(lang, k, { e: emojiMap, ...vars }),
  locale: () => lang
})

// The screen leans on ctx.telegram.getChatMember for admin checks.
// Factor the stub so individual tests can flip admin on/off.
const mkCtx = ({ isAdmin = false, event = null, fromId = 7 } = {}) => {
  const calls = { editMessageText: [], deleteMessage: 0, restrictChatMember: 0, unbanChatMember: 0 }
  const edits = []
  const ModEvent = {
    findOne: async ({ eventId }) => event && event.eventId === eventId ? event : null,
    findOneAndUpdate: async ({ eventId }, patch) => {
      if (!event || event.eventId !== eventId) return null
      Object.assign(event, patch.$set || {})
      return event
    }
  }
  const ScheduledDeletion = { schedule: async () => ({}), deleteOne: async () => ({ deletedCount: 1 }) }

  const telegram = {
    callApi: async (method, payload) => {
      if (method === 'sendMessage') return { message_id: 1 }
      if (method === 'editMessageText') {
        calls.editMessageText.push(payload)
        edits.push(payload)
        return {}
      }
      if (method === 'unbanChatMember') { calls.unbanChatMember++; return true }
      if (method === 'getChatMember') {
        return { status: isAdmin ? 'administrator' : 'member' }
      }
      return null
    },
    getChatMember: async () => ({ status: isAdmin ? 'administrator' : 'member' }),
    deleteMessage: async () => { calls.deleteMessage++ },
    restrictChatMember: async () => { calls.restrictChatMember++ }
  }

  return {
    ctx: {
      telegram,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: fromId, first_name: 'AdminAlice' },
      db: { ModEvent, ScheduledDeletion },
      i18n: mkI18n('uk'),
      // Telegraf exposes `ctx.deleteMessage()` as a shortcut on ctx itself.
      deleteMessage: async () => { calls.deleteMessage++ },
      callbackQuery: {
        data: 'm:v1:mod.event:why:' + (event && event.eventId),
        message: { message_id: 500 }
      }
    },
    edits,
    calls
  }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('screen registers at id mod.event with public access', () => {
  try { screen.register() } catch (e) { if (!/already registered/.test(e.message)) throw e }
  const s = registry.getMenu('mod.event')
  assert.ok(s, 'registered')
  assert.strictEqual(s.access, 'public')
})

test('why action: non-admin → expanded renders with only [less] button', async () => {
  const event = {
    eventId: 'ev1',
    actionType: 'auto_ban',
    targetId: 123,
    targetName: 'Spammer',
    confidence: 88,
    reason: 'phishing',
    messagePreview: 'buy crypto',
    chatId: -100500
  }
  const { ctx, edits } = mkCtx({ isAdmin: false, event })
  const res = await screen.handle(ctx, 'why', ['ev1'])
  assert.strictEqual(res.render, false)
  assert.ok(res.silent)
  assert.strictEqual(edits.length, 1)
  const flat = edits[0].reply_markup.inline_keyboard.flat()
  assert.strictEqual(flat.length, 1)
  assert.ok(flat[0].text.includes('Зменшити'))
  // Expanded text includes confidence and preview
  assert.ok(edits[0].text.includes('📊 88%'))
  assert.ok(edits[0].text.includes('«buy crypto»'))
})

test('why action: admin → expanded has [less][undo] + [hide]', async () => {
  const event = { eventId: 'ev2', actionType: 'auto_ban', targetId: 1, targetName: 'X', chatId: -100500 }
  const { ctx, edits } = mkCtx({ isAdmin: true, event })
  await screen.handle(ctx, 'why', ['ev2'])
  const flat = edits[0].reply_markup.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text.includes('Зменшити')))
  assert.ok(flat.some(b => b.text.includes('Розблокувати')))
  assert.ok(flat.some(b => b.text.includes('Сховати')))
})

test('less action: re-renders compact view', async () => {
  const event = { eventId: 'ev3', actionType: 'auto_ban', targetId: 1, targetName: 'Y', chatId: -100500 }
  const { ctx, edits } = mkCtx({ isAdmin: false, event })
  await screen.handle(ctx, 'less', ['ev3'])
  assert.strictEqual(edits.length, 1)
  assert.ok(edits[0].text.startsWith('⛔'))
  // Compact keyboard has both [why] and [hide]
  const flat = edits[0].reply_markup.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text.includes('За що')))
  assert.ok(flat.some(b => b.text.includes('Сховати')))
})

test('hide action: non-admin → toast + no deletion', async () => {
  const event = { eventId: 'ev4', actionType: 'auto_ban', targetId: 1, targetName: 'Z', chatId: -100500 }
  const { ctx, calls } = mkCtx({ isAdmin: false, event })
  const res = await screen.handle(ctx, 'hide', ['ev4'])
  assert.strictEqual(res.toast, 'menu.access.only_admins')
  assert.strictEqual(calls.deleteMessage, 0)
})

test('hide action: admin → deletes message', async () => {
  const event = { eventId: 'ev5', actionType: 'auto_ban', targetId: 1, targetName: 'Q', chatId: -100500 }
  const { ctx, calls } = mkCtx({ isAdmin: true, event })
  const res = await screen.handle(ctx, 'hide', ['ev5'])
  assert.strictEqual(res.toast, 'mod_event.toast.hidden')
  assert.strictEqual(calls.deleteMessage, 1)
})

test('undo: non-admin rejected', async () => {
  const event = { eventId: 'ev6', actionType: 'auto_ban', targetId: 42, targetName: 'U', chatId: -100500 }
  const { ctx, calls } = mkCtx({ isAdmin: false, event })
  const res = await screen.handle(ctx, 'undo', ['ev6'])
  assert.strictEqual(res.toast, 'menu.access.only_admins')
  assert.strictEqual(calls.restrictChatMember, 0)
})

test('undo: admin → restrictChatMember + override rerender', async () => {
  const event = {
    eventId: 'ev7',
    actionType: 'auto_ban',
    targetId: 42,
    targetName: 'V',
    chatId: -100500,
    toObject () { return { ...this } }
  }
  const { ctx, edits, calls } = mkCtx({ isAdmin: true, event })
  const res = await screen.handle(ctx, 'undo', ['ev7'])
  assert.strictEqual(res.toast, 'mod_event.toast.undone')
  assert.strictEqual(calls.restrictChatMember, 1)
  assert.strictEqual(event.actionType, 'override', 'event transitioned to override')
  assert.strictEqual(edits.length, 1)
  assert.ok(edits[0].text.startsWith('↩️'))
  assert.ok(edits[0].text.includes('AdminAlice'))
})

test('unknown eventId → not_found toast', async () => {
  const { ctx } = mkCtx({ isAdmin: true, event: null })
  const res = await screen.handle(ctx, 'why', ['nonexistent'])
  assert.strictEqual(res.toast, 'mod_event.toast.not_found')
})

test('missing eventId arg → not_found toast', async () => {
  const { ctx } = mkCtx({ isAdmin: true, event: null })
  const res = await screen.handle(ctx, 'why', [])
  assert.strictEqual(res.toast, 'mod_event.toast.not_found')
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
