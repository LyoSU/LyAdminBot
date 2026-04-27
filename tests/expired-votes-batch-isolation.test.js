// Regression test: processExpiredVotes must not let one bad vote
// skip the rest of the batch.
//
// Before 2026-04-27 the function had a single try/catch wrapping the
// whole `for` loop. When the I18n template compile failed for one
// vote (the "Failed to compile template" bug), the loop aborted and
// every subsequent expired vote in that batch waited until the next
// minute. Same shape would happen for any transient per-vote failure
// (Mongo blip, Telegram 429, malformed document).
//
// This test pins the corrected shape: each iteration is wrapped in
// its own try/catch, and the loop completes regardless of how many
// individual votes throw.

const assert = require('assert')

// We pre-stub the heavy require chain (mongoose models, NLP client,
// Qdrant, etc.) so the handler module can be required in a unit-test
// process without touching a database. The stub maps the same module
// IDs the handler does and returns minimal shapes.
const Module = require('module')
const stubMap = new Map()
const realLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (stubMap.has(request)) return stubMap.get(request)
  return realLoad.call(this, request, parent, ...rest)
}

// Stubs for everything spam-vote.js pulls that has side effects.
stubMap.set('../helpers/vote-ui', {
  updateVoteUI: async () => {},
  showResultUI: async () => {}
})
stubMap.set('../helpers/spam-signatures', { addSignature: async () => null })
stubMap.set('../helpers/reputation', { getReputationStatus: () => 'neutral' })
stubMap.set('../helpers/admin-override', { applyAdminOverride: async () => null })
stubMap.set('../helpers/logger', {
  spamVote: {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}
  },
  nlp: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }
})
stubMap.set('../helpers/message-cleanup', { scheduleDeletion: async () => {} })
stubMap.set('../helpers/mod-log', { logModEvent: async () => {} })
stubMap.set('../helpers/nlp-client', { CONFIG: { enabled: false } })
stubMap.set('../helpers/admin-feedback', {})

const { processExpiredVotes } = require('../handlers/spam-vote')

// Vote A: triggers an exception when its `voteTally` field is read.
// Mimics the real failure mode where the per-vote i18n / persistence
// path throws something compile-template-shaped.
const badVote = {
  eventId: 'BAD',
  chatId: -100123,
  bannedUserName: 'Bad',
  notificationMessageId: 1,
  notificationChatId: -100123,
  get voteTally () { throw new Error('synthetic per-vote failure') },
  save: async () => {}
}

// Vote B: clean, expired, with no votes — should resolve to spam.
let bSaved = false
const goodVote = {
  eventId: 'GOOD',
  chatId: -100456,
  bannedUserName: 'Good',
  notificationMessageId: 2,
  notificationChatId: -100456,
  voteTally: { spamWeighted: 0, cleanWeighted: 0, spamCount: 0, cleanCount: 0 },
  save: async function () { bSaved = true; return this },
  result: 'pending'
}

// Vote C: another good one to confirm we keep going past TWO bad slots.
let cSaved = false
const goodVote2 = {
  eventId: 'GOOD2',
  chatId: -100789,
  bannedUserName: 'Good2',
  notificationMessageId: 3,
  notificationChatId: -100789,
  voteTally: { spamWeighted: 0, cleanWeighted: 0, spamCount: 0, cleanCount: 0 },
  save: async function () { cSaved = true; return this },
  result: 'pending'
}

const fakeDb = {
  SpamVote: { findExpired: async () => [badVote, goodVote, goodVote2] },
  Group: { findOne: async () => ({ locale: 'en' }) }
}

const editedMessages = []
const fakeTelegram = {
  editMessageText: async (chatId, messageId, _, text) => {
    editedMessages.push({ chatId, messageId, text })
  },
  deleteMessage: async () => {}
}

// Real I18n config shape (see bot.js:createI18n).
const path = require('path')
const I18n = require('telegraf-i18n')
const emojiMap = require('../helpers/emoji-map')
const fakeI18n = new I18n({
  directory: path.resolve(__dirname, '..', 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true,
  templateData: { e: emojiMap }
})

;(async () => {
  // The function must NOT throw when one vote is bad — it must log
  // and proceed.
  await processExpiredVotes(fakeDb, fakeTelegram, fakeI18n)

  assert.strictEqual(bSaved, true, 'goodVote (after badVote) must have been saved — batch was aborted by per-vote exception')
  assert.strictEqual(cSaved, true, 'goodVote2 (further down the batch) must have been saved')
  assert.strictEqual(goodVote.result, 'spam', 'goodVote should resolve to spam (no-votes default)')
  assert.strictEqual(goodVote2.result, 'spam', 'goodVote2 should resolve to spam (no-votes default)')
  assert.ok(editedMessages.find((m) => m.chatId === -100456), 'goodVote notification must be edited')
  assert.ok(editedMessages.find((m) => m.chatId === -100789), 'goodVote2 notification must be edited')
  console.log('  ✓ bad vote in batch does NOT skip subsequent votes')
  console.log('  ✓ good votes after the bad one resolve normally (timeout → spam)')
  console.log('  ✓ notifications for surviving votes are edited')
  console.log('\n3 passed, 0 failed')
  process.exit(0)
})().catch((err) => {
  console.error('Test crashed:', err)
  process.exit(1)
})
