// Post-result spam-vote action tests (§10).
//
// Wires the `perma` and `still_ban` callbacks routed through the
// `mod.event` screen onto a SpamVote document. Verifies admin gating,
// banChatMember calls, message edit, and ModLog entry.

const assert = require('assert')
const path = require('path')
const I18n = require('telegraf-i18n')
const emojiMap = require('../helpers/emoji-map')

// Reset registry so re-registering doesn't throw
delete require.cache[require.resolve('../helpers/menu/registry')]
delete require.cache[require.resolve('../helpers/menu/screens/mod-event')]

const screen = require('../helpers/menu/screens/mod-event')

const i18nLoader = new I18n({
  directory: path.resolve(__dirname, '..', 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})
const mkI18n = (lang = 'uk') => ({
  t: (k, vars = {}) => i18nLoader.t(lang, k, { e: emojiMap, ...vars }),
  locale: () => lang
})

const mkCtx = ({ isAdmin = false, spamVote = null, fromId = 7 } = {}) => {
  const calls = { banChatMember: [], editMessageText: [], modLog: [] }
  const SpamVote = { findOne: async ({ eventId }) => spamVote && spamVote.eventId === eventId ? spamVote : null }
  // ModLog stub — the helper uses ModLog.create()
  const ModLog = { create: async (entry) => { calls.modLog.push(entry); return entry } }
  // ModEvent must exist for screen lookup but won't be hit for perma/still_ban.
  const ModEvent = { findOne: async () => null, findOneAndUpdate: async () => null }

  const telegram = {
    callApi: async (method, payload) => {
      if (method === 'banChatMember') { calls.banChatMember.push(payload); return true }
      if (method === 'editMessageText') { calls.editMessageText.push(payload); return {} }
      return null
    },
    getChatMember: async () => ({ status: isAdmin ? 'administrator' : 'member' })
  }

  return {
    ctx: {
      telegram,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: fromId, first_name: 'AdminAlice' },
      db: { SpamVote, ModEvent, ModLog },
      i18n: mkI18n('uk'),
      callbackQuery: {
        data: 'm:v1:mod.event:perma:' + (spamVote && spamVote.eventId),
        message: { message_id: 500, text: '⛔ Спам підтверджено' }
      }
    },
    calls
  }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('perma: non-admin rejected', async () => {
  const spamVote = { eventId: 'sv1', chatId: -100500, bannedUserId: 99, bannedUserName: 'Spammer' }
  const { ctx, calls } = mkCtx({ isAdmin: false, spamVote })
  const res = await screen.handle(ctx, 'perma', ['sv1'])
  assert.strictEqual(res.toast, 'menu.access.only_admins')
  assert.strictEqual(calls.banChatMember.length, 0)
})

test('perma: admin → banChatMember without until_date + edit + modlog', async () => {
  const spamVote = { eventId: 'sv2', chatId: -100500, bannedUserId: 42, bannedUserName: 'Spammer' }
  const { ctx, calls } = mkCtx({ isAdmin: true, spamVote })
  const res = await screen.handle(ctx, 'perma', ['sv2'])
  assert.strictEqual(res.toast, 'spam_vote.toast.perma_done')
  assert.strictEqual(calls.banChatMember.length, 1)
  assert.strictEqual(calls.banChatMember[0].chat_id, -100500)
  assert.strictEqual(calls.banChatMember[0].user_id, 42)
  assert.strictEqual(calls.banChatMember[0].until_date, undefined, 'no until_date for permanent ban')
  // Edit appended a perma marker and dropped the keyboard
  assert.strictEqual(calls.editMessageText.length, 1)
  assert.ok(calls.editMessageText[0].text.includes('назавжди'))
  assert.deepStrictEqual(calls.editMessageText[0].reply_markup, { inline_keyboard: [] })
  // ModLog entry written with manual_ban
  assert.strictEqual(calls.modLog.length, 1)
  assert.strictEqual(calls.modLog[0].eventType, 'manual_ban')
  assert.ok(calls.modLog[0].reason.includes('post_vote_perma'))
})

test('still_ban: non-admin rejected', async () => {
  const spamVote = { eventId: 'sv3', chatId: -100500, bannedUserId: 88 }
  const { ctx, calls } = mkCtx({ isAdmin: false, spamVote })
  const res = await screen.handle(ctx, 'still_ban', ['sv3'])
  assert.strictEqual(res.toast, 'menu.access.only_admins')
  assert.strictEqual(calls.banChatMember.length, 0)
})

test('still_ban: admin → banChatMember with until_date 30d + override modlog', async () => {
  const spamVote = { eventId: 'sv4', chatId: -100500, bannedUserId: 77, bannedUserUsername: 'spammer' }
  const { ctx, calls } = mkCtx({ isAdmin: true, spamVote })
  const before = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 - 5
  const res = await screen.handle(ctx, 'still_ban', ['sv4'])
  assert.strictEqual(res.toast, 'spam_vote.toast.still_ban_done')
  assert.strictEqual(calls.banChatMember.length, 1)
  assert.ok(calls.banChatMember[0].until_date >= before, 'until_date 30d in future')
  assert.strictEqual(calls.editMessageText.length, 1)
  assert.ok(calls.editMessageText[0].text.includes('@spammer'))
  assert.ok(calls.editMessageText[0].text.includes('AdminAlice'))
  assert.ok(calls.editMessageText[0].text.includes('vote'))
  // ModLog uses 'override' eventType per spec
  assert.strictEqual(calls.modLog.length, 1)
  assert.strictEqual(calls.modLog[0].eventType, 'override')
  assert.strictEqual(calls.modLog[0].reason, 'post_vote_clean_override')
})

test('perma: missing SpamVote → not_found toast', async () => {
  const { ctx, calls } = mkCtx({ isAdmin: true, spamVote: null })
  const res = await screen.handle(ctx, 'perma', ['missing'])
  assert.strictEqual(res.toast, 'spam_vote.cb.not_found')
  assert.strictEqual(calls.banChatMember.length, 0)
})

const adminCache = require('../helpers/admin-cache')

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    adminCache.clearAll()
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + (e.stack || e.message)) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
