// mod.vote.details screen tests (§10): registration, render shape, collapse.

const assert = require('assert')
const path = require('path')
const I18n = require('telegraf-i18n')
const emojiMap = require('../helpers/emoji-map')

// Fresh registry per run.
delete require.cache[require.resolve('../helpers/menu/registry')]
delete require.cache[require.resolve('../helpers/menu/screens/mod-vote-details')]

const screen = require('../helpers/menu/screens/mod-vote-details')
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

const mkSpamVote = (overrides = {}) => Object.assign({
  eventId: 'ev1',
  chatId: -100500,
  bannedUserId: 99,
  bannedUserName: 'Spammy',
  bannedUserUsername: 'spammy',
  userContext: { reputationScore: 50, accountAgeDays: 100, messagesInGroup: 5, signals: [] },
  aiConfidence: 87,
  aiReason: 'Inappropriate content',
  messagePreview: 'Buy crypto now at example.com',
  messageHash: 'deadbeefcafe1234567890abcdef',
  expiresAt: new Date(Date.now() + 60000),
  result: 'pending',
  voteTally: { spamCount: 2, cleanCount: 1, spamWeighted: 4, cleanWeighted: 1 },
  actionTaken: { banned: false },
  voters: [
    { userId: 1, username: 'alice', vote: 'spam', weight: 3, votedAt: new Date() },
    { userId: 2, displayName: 'Bob', vote: 'spam', weight: 1, votedAt: new Date() },
    { userId: 3, username: 'carol', vote: 'clean', weight: 1, votedAt: new Date() }
  ]
}, overrides)

const mkCtx = ({ spamVote = null } = {}) => {
  const calls = { editMessageText: [] }
  const SpamVote = { findOne: async ({ eventId }) => spamVote && spamVote.eventId === eventId ? spamVote : null }
  const telegram = {
    callApi: async (method, payload) => {
      if (method === 'editMessageText') { calls.editMessageText.push(payload); return {} }
      return null
    },
    // updateVoteUI uses the ctx.telegram.editMessageText shorthand directly.
    editMessageText: async (chatId, messageId, _inlineMsgId, text, opts) => {
      calls.editMessageText.push({ chat_id: chatId, message_id: messageId, text, ...opts })
      return {}
    }
  }
  return {
    ctx: {
      telegram,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 5, first_name: 'Viewer' },
      db: { SpamVote },
      i18n: mkI18n('uk'),
      callbackQuery: {
        data: 'm:v1:mod.vote.details:open:' + (spamVote && spamVote.eventId),
        message: { message_id: 700 }
      }
    },
    calls
  }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('screen registers at id mod.vote.details with public access', () => {
  try { screen.register() } catch (e) { if (!/already registered/.test(e.message)) throw e }
  const s = registry.getMenu('mod.vote.details')
  assert.ok(s, 'registered')
  assert.strictEqual(s.access, 'public')
})

test('renderDetailsText: includes confidence, preview, tally (admin view has hash)', () => {
  const sv = mkSpamVote()
  const text = screen.renderDetailsText(mkI18n('uk'), sv, { viewerIsAdmin: true })
  assert.ok(text.includes('⚖️'), 'has progress title')
  assert.ok(text.includes('87%'), 'confidence rendered')
  assert.ok(text.includes('«Buy crypto'), 'preview rendered')
  assert.ok(text.includes('deadbeefcafe'), 'fingerprint hash rendered for admin')
  assert.ok(/🚫\s*4/.test(text), 'spam weighted in tally')
  assert.ok(/✅\s*1/.test(text), 'clean weighted in tally')
})

test('renderDetailsText: non-admin does NOT see fingerprint hash', () => {
  const sv = mkSpamVote()
  const text = screen.renderDetailsText(mkI18n('uk'), sv, { viewerIsAdmin: false })
  assert.ok(!text.includes('deadbeefcafe'), 'hash hidden from non-admin')
})

test('renderDetailsText: admin hash truncated to 12 chars', () => {
  const sv = mkSpamVote({ messageHash: 'a'.repeat(64) })
  const text = screen.renderDetailsText(mkI18n('uk'), sv, { viewerIsAdmin: true })
  assert.ok(text.includes('a'.repeat(12)))
  assert.ok(!text.includes('a'.repeat(13)))
})

test('formatVoterList: top 3 by weight desc', () => {
  const lines = screen.formatVoterList([
    { userId: 1, username: 'low', vote: 'spam', weight: 1, votedAt: new Date(1000) },
    { userId: 2, username: 'high', vote: 'spam', weight: 3, votedAt: new Date(2000) },
    { userId: 3, username: 'mid', vote: 'clean', weight: 2, votedAt: new Date(3000) },
    { userId: 4, username: 'extra', vote: 'spam', weight: 1, votedAt: new Date(4000) }
  ])
  assert.strictEqual(lines.length, 3)
  assert.ok(lines[0].includes('high'), 'highest weight first')
  assert.ok(lines[1].includes('mid'))
  assert.ok(lines[0].includes('×3'))
})

test('formatVoterList: empty/undefined → null', () => {
  assert.strictEqual(screen.formatVoterList([]), null)
  assert.strictEqual(screen.formatVoterList(null), null)
})

test('buildKeyboard: pending vote → vote buttons + collapse', () => {
  const sv = mkSpamVote()
  const kb = screen.buildKeyboard(mkI18n('uk'), sv)
  assert.strictEqual(kb.inline_keyboard.length, 2, 'two rows')
  // First row: vote buttons
  assert.strictEqual(kb.inline_keyboard[0].length, 2)
  assert.ok(kb.inline_keyboard[0][0].callback_data.startsWith('sv:ev1:spam'))
  assert.ok(kb.inline_keyboard[0][1].callback_data.startsWith('sv:ev1:clean'))
  // Second row: collapse
  assert.ok(kb.inline_keyboard[1][0].text.includes('Зменшити'))
  assert.ok(kb.inline_keyboard[1][0].callback_data.includes('mod.vote.details:less'))
})

test('buildKeyboard: resolved vote → only collapse row (no vote buttons)', () => {
  const sv = mkSpamVote({ result: 'spam', expiresAt: new Date(Date.now() - 1000) })
  const kb = screen.buildKeyboard(mkI18n('uk'), sv)
  assert.strictEqual(kb.inline_keyboard.length, 1)
  assert.ok(kb.inline_keyboard[0][0].text.includes('Зменшити'))
})

test('handle open: edits message with details + keyboard', async () => {
  const sv = mkSpamVote()
  const { ctx, calls } = mkCtx({ spamVote: sv })
  const res = await screen.handle(ctx, 'open', ['ev1'])
  assert.ok(res.silent)
  assert.strictEqual(calls.editMessageText.length, 1)
  assert.ok(calls.editMessageText[0].text.includes('87%'))
  assert.ok(calls.editMessageText[0].reply_markup.inline_keyboard.length >= 1)
})

test('handle less: re-renders active vote view (calls updateVoteUI path)', async () => {
  const sv = mkSpamVote()
  // Make it look saved with notification ids so updateVoteUI does the edit.
  sv.notificationMessageId = 700
  sv.notificationChatId = -100500
  const { ctx, calls } = mkCtx({ spamVote: sv })
  const res = await screen.handle(ctx, 'less', ['ev1'])
  assert.ok(res.silent)
  // updateVoteUI calls telegram.editMessageText
  assert.strictEqual(calls.editMessageText.length, 1)
  // Active vote rendering includes the title for the blocked/banned banner
  assert.ok(calls.editMessageText[0].text.includes('⚖️'), 'progress block included')
})

test('handle: missing SpamVote → not_found toast', async () => {
  const { ctx } = mkCtx({ spamVote: null })
  const res = await screen.handle(ctx, 'open', ['nope'])
  assert.strictEqual(res.toast, 'spam_vote.cb.not_found')
})

test('handle: missing arg → not_found toast', async () => {
  const { ctx } = mkCtx({ spamVote: null })
  const res = await screen.handle(ctx, 'open', [])
  assert.strictEqual(res.toast, 'spam_vote.cb.not_found')
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
