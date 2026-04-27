// Regression test for the 2026-04-27 "Failed to compile template" bug in
// the spam-vote expired-vote handler.
//
// Background jobs (handlers/spam-vote.js#processExpiredVotes,
// helpers/digest-scheduler.js#processAdmin, etc.) build their own
// I18nContext via i18n.createContext(locale, {}) — they bypass the
// per-update middleware stack. Before the fix, the `e: emojiMap` symbol
// only existed inside ctx.i18n.t after middlewares/emoji-inject wrapped
// it. So any background render of a template containing `${e.*}` (and
// every spam_vote.* template uses one) blew up inside vm.Script with
// "ReferenceError: e is not defined", which compile-template silently
// rethrew as the opaque "Failed to compile template" — masking the
// cause and stranding the vote message in its pre-expiry state.
//
// Fix: `e: emojiMap` lives in I18n config.templateData, so EVERY
// I18nContext (middleware-wrapped or not) can resolve ${e.*}.
//
// This test pins the contract: a freshly-created I18nContext (the exact
// shape that processExpiredVotes uses) MUST render every spam_vote.*
// template that the codepath touches, in every shipped locale, without
// throwing.

const assert = require('assert')
const path = require('path')
const I18n = require('telegraf-i18n')

const emojiMap = require('../helpers/emoji-map')
const { buildCleanResultNotification, buildSpamResultNotification } = require('../helpers/vote-ui')

// Build the I18n instance EXACTLY as bot.js:createI18n() does. If
// production wiring drifts (e.g. someone removes templateData), this
// mirror won't catch it — that's bot-added-get-message.test.js's job.
// Here we exercise the runtime behaviour the production wiring is
// supposed to deliver.
const i18n = new I18n({
  directory: path.resolve(__dirname, '..', 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true,
  templateData: { e: emojiMap }
})

const LOCALES = ['en', 'uk', 'ru', 'by', 'tr']

// Keys that processExpiredVotes / processVoteResult / showResultUI hit.
// Lifted from handlers/spam-vote.js + helpers/vote-ui.js. If we add new
// background-rendered keys, append them here so the regression net
// keeps catching ${e.*}-shaped landmines.
const KEYS_USED_IN_BACKGROUND = [
  // Direct from processExpiredVotes:
  ['spam_vote.timeout_confirmed', { name: 'Alice' }],
  // From buildSpamResultNotification (winner=spam path):
  ['spam_vote.title_spam', {}],
  ['spam_vote.user_info', { name: 'Alice' }],
  ['spam_vote.reputation_change', { oldScore: 50, newScore: 35 }],
  ['spam_vote.added_to_signatures', {}],
  ['spam_vote.voters_spam', { count: 3 }],
  ['spam_vote.voters_clean', { count: 0 }],
  ['spam_vote.voter_line', { index: 1, name: 'Bob', weight: ' (×2)' }],
  ['spam_vote.voters_empty', {}],
  ['spam_vote.result', { spam: 3, clean: 0 }],
  // From buildCleanResultNotification (winner=clean path):
  ['spam_vote.title_clean', {}],
  ['spam_vote.status_trusted', {}],
  // Easter eggs that getVoteEasterEgg() may pull:
  ['spam_vote.result_unanimous_spam', {}],
  ['spam_vote.result_unanimous_clean', {}],
  ['spam_vote.result_close_call', {}],
  ['spam_vote.result_landslide', {}],
  ['spam_vote.result_fast', {}],
  ['spam_vote.result_solo_hero', {}]
]

let passed = 0
let failed = 0

// 1. Per-locale, per-key smoke: rendering must not throw and must not
//    produce the empty string. (telegraf-i18n's allowMissing:true would
//    return the key itself — that's a soft miss, not the hard
//    "Failed to compile template" failure we're guarding against.)
for (const locale of LOCALES) {
  // Same call shape as handlers/spam-vote.js:440.
  const ctx = i18n.createContext(locale, {})

  for (const [key, vars] of KEYS_USED_IN_BACKGROUND) {
    try {
      const out = ctx.t(key, vars)
      assert.strictEqual(typeof out, 'string', `${locale}.${key}: not a string`)
      // The whole point: ${e.*} in the YAML must have resolved. If it
      // hasn't, the vm threw and compile-template wrapped it as
      // "Failed to compile template" — which would have surfaced as a
      // throw above, not as untemplated output. Belt-and-braces check
      // that no `${` literal slipped through (would mean a missing
      // variable, not a vm error).
      assert.ok(!out.includes('${'), `${locale}.${key}: unresolved placeholder in: ${out}`)
      passed++
    } catch (err) {
      failed++
      console.error(`  ✗ ${locale}.${key} — ${err.message}`)
    }
  }
}

// 2. Full builder smoke: build the real result-notification HTML the
//    way showResultUI() does, with a fresh I18nContext (not a
//    middleware-wrapped one). This catches drift in vote-ui.js too —
//    e.g. if someone adds a new `${e.foo}` key to a builder without
//    updating the locale-data plumbing.
const fakeI18nLikeBackgroundJob = i18n.createContext('uk', {})
const fakeSpamVote = {
  bannedUserName: 'Alice',
  bannedUserUsername: 'alice',
  voters: [
    { username: 'admin1', displayName: 'Admin One', vote: 'spam', weight: 3 },
    { username: 'user1', displayName: 'User One', vote: 'clean', weight: 1 }
  ],
  voteTally: { spamWeighted: 3, cleanWeighted: 1 },
  resolvedAt: new Date('2026-04-27T20:30:00Z'),
  createdAt: new Date('2026-04-27T20:25:00Z')
}

try {
  const spamHtml = buildSpamResultNotification(
    fakeSpamVote,
    fakeI18nLikeBackgroundJob,
    { oldScore: 50, newScore: 35 }
  )
  assert.ok(spamHtml.length > 0, 'spam result render is empty')
  assert.ok(!spamHtml.includes('${'), `spam result has unresolved placeholder: ${spamHtml}`)
  passed++

  const cleanVote = { ...fakeSpamVote, voteTally: { spamWeighted: 0, cleanWeighted: 2 } }
  const cleanHtml = buildCleanResultNotification(
    cleanVote,
    fakeI18nLikeBackgroundJob,
    { oldScore: 30, newScore: 50 }
  )
  assert.ok(cleanHtml.length > 0, 'clean result render is empty')
  assert.ok(!cleanHtml.includes('${'), `clean result has unresolved placeholder: ${cleanHtml}`)
  passed++
} catch (err) {
  failed++
  console.error(`  ✗ builder render — ${err.message}`)
}

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} failed`)
  process.exit(1)
}
console.log(`  ✓ all ${KEYS_USED_IN_BACKGROUND.length} background-rendered keys resolve in ${LOCALES.length} locales`)
console.log(`  ✓ buildSpamResultNotification + buildCleanResultNotification render with createContext(locale, {})`)
console.log(`\n${passed} passed, 0 failed`)

// helpers/vote-ui pulls in the spam-check / spam-signatures stack which
// transitively opens Mongo + Qdrant clients on require. Those handles
// don't auto-close, so spawnSync(tests/run.js) would hang here without
// an explicit exit. Standalone debugging still works because we always
// reach this line on a passing run.
process.exit(0)
