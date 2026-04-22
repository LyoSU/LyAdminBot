/**
 * Regression tests for helpers/spam-signals.js
 *
 * Run: node tests/spam-signals.test.js
 *
 * Validates:
 *   - uniqueness rolling-window math
 *   - identity history change detection
 *   - deterministic verdicts: every SPAM rule must NOT fire on a clean
 *     baseline profile, every CLEAN rule must NOT fire on a known spammer
 *     profile (precision-first principle).
 */

const assert = require('assert')
const {
  updateUniqueness,
  trackIdentity,
  buildUserSignals,
  countRecentChanges,
  computeDeterministicVerdict
} = require('../helpers/spam-signals')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// --------------------------------------------------------------------------
// Uniqueness tracker
// --------------------------------------------------------------------------

test('uniqueness: distinct messages → ratio = 1.0', () => {
  // Use semantically different messages — normalizeHeavy strips numbers, so
  // "msg 1" / "msg 2" all hash identically (which is the desired dedup
  // against numeric-only variation spammers; tested separately below).
  const u = {}
  const corpus = [
    'дякую за допомогу справді корисна порада',
    'щось не виходить підкажіть будь ласка як зробити',
    'тут є багато інформації по цій темі цікаво',
    'привіт всім хто читає цей чат сьогодні',
    'хочу поділитися своїм досвідом по даному питанню',
    'дуже корисно знати про це раніше не чув',
    'може хтось пояснити як працює ця функція тут',
    'в нашій групі багато активних учасників сьогодні',
    'питання щодо налаштувань треба розібратися детально',
    'звертаю увагу на цю важливу деталь у документації'
  ]
  for (const m of corpus) updateUniqueness(u, m)
  assert.strictEqual(u.globalStats.trackedMessages, corpus.length)
  assert.strictEqual(u.globalStats.uniquenessRatio, 1)
})

test('uniqueness: numeric-only variations DO collapse (anti-dodge)', () => {
  // Spammers try to defeat dedup by varying numbers/prices. Heavy
  // normalization erases this so all map to the same hash.
  const u = {}
  for (let i = 0; i < 10; i++) updateUniqueness(u, `Заробляйте від ${i * 1000} грн на день write me`)
  assert.strictEqual(u.globalStats.trackedMessages, 10)
  assert.ok(u.globalStats.uniquenessRatio <= 0.2, `ratio=${u.globalStats.uniquenessRatio}`)
})

test('uniqueness: identical messages → ratio drops sharply', () => {
  const u = {}
  for (let i = 0; i < 20; i++) updateUniqueness(u, 'this is the same spam message every time')
  assert.strictEqual(u.globalStats.trackedMessages, 20)
  assert.ok(u.globalStats.uniquenessRatio <= 0.1, `ratio=${u.globalStats.uniquenessRatio}`)
})

test('uniqueness: rolling window caps at 50 samples', () => {
  const u = {}
  for (let i = 0; i < 80; i++) updateUniqueness(u, `msg ${i} unique`)
  assert.ok(u.globalStats.uniquenessSamples.length <= 50)
})

test('uniqueness: emoji-only messages do not affect ratio', () => {
  const u = {}
  // 10 distinct meaningful → ratio 1
  for (let i = 0; i < 10; i++) updateUniqueness(u, `meaningful conversation message ${i} text`)
  const before = u.globalStats.trackedMessages
  // 5 emoji-only → should not increment
  for (let i = 0; i < 5; i++) updateUniqueness(u, '👍😀❤️')
  assert.strictEqual(u.globalStats.trackedMessages, before)
})

// --------------------------------------------------------------------------
// Identity tracking
// --------------------------------------------------------------------------

test('trackIdentity: first call seeds history', () => {
  const u = {}
  trackIdentity(u, { first_name: 'Pavel', last_name: 'D', username: 'paveld' })
  assert.strictEqual(u.nameHistory.length, 1)
  assert.strictEqual(u.usernameHistory.length, 1)
  assert.strictEqual(u.nameHistory[0].value, 'Pavel D')
})

test('trackIdentity: unchanged → no new entry', () => {
  const u = {}
  trackIdentity(u, { first_name: 'Pavel', username: 'paveld' })
  trackIdentity(u, { first_name: 'Pavel', username: 'paveld' })
  trackIdentity(u, { first_name: 'Pavel', username: 'paveld' })
  assert.strictEqual(u.nameHistory.length, 1)
  assert.strictEqual(u.usernameHistory.length, 1)
})

test('trackIdentity: change appended (newest first)', () => {
  const u = {}
  trackIdentity(u, { first_name: 'A', username: 'a_one' })
  trackIdentity(u, { first_name: 'B', username: 'a_one' })
  assert.strictEqual(u.nameHistory.length, 2)
  assert.strictEqual(u.nameHistory[0].value, 'B')
})

test('countRecentChanges: only counts entries within last 24h', () => {
  const old = { value: 'X', seenAt: new Date(Date.now() - 48 * 3600 * 1000) }
  const recent = { value: 'Y', seenAt: new Date(Date.now() - 1 * 3600 * 1000) }
  assert.strictEqual(countRecentChanges([recent, old]), 1)
})

// --------------------------------------------------------------------------
// Deterministic verdicts — precision tests
// --------------------------------------------------------------------------

const cleanUser = {
  globalStats: { totalMessages: 200, groupsActive: 4, spamDetections: 0, cleanMessages: 50, uniquenessRatio: 0.95, trackedMessages: 50 },
  reputation: { score: 80, status: 'trusted' },
  nameHistory: [{ value: 'Pavel', seenAt: new Date(Date.now() - 365 * 24 * 3600 * 1000) }],
  usernameHistory: [{ value: 'pavel', seenAt: new Date(Date.now() - 365 * 24 * 3600 * 1000) }],
  externalBan: null,
  telegram_id: 123456
}

const spammerUser = {
  globalStats: { totalMessages: 5, groupsActive: 1, spamDetections: 0, cleanMessages: 0, uniquenessRatio: 0.95, trackedMessages: 0 },
  reputation: { score: 50, status: 'neutral' },
  nameHistory: [],
  usernameHistory: [],
  externalBan: { lols: { banned: true, spamFactor: 0.92, offenses: 5 } },
  telegram_id: 8800000000
}

test('verdict: clean rule does not misfire on spammer', () => {
  const userSignals = buildUserSignals(spammerUser, { id: spammerUser.telegram_id })
  const verdict = computeDeterministicVerdict({
    userSignals,
    quickAssessment: { risk: 'low', signals: [], trustSignals: [] },
    userContext: { isNewAccount: true, messageCount: 1, isReply: false },
    text: 'hi'
  })
  assert.ok(!verdict || verdict.decision === 'spam', `clean rule misfired on spammer: ${JSON.stringify(verdict)}`)
})

test('verdict: spam rule does not misfire on trusted clean user', () => {
  const userSignals = buildUserSignals(cleanUser, { id: cleanUser.telegram_id })
  const verdict = computeDeterministicVerdict({
    userSignals,
    quickAssessment: { risk: 'low', signals: [], trustSignals: ['is_reply'] },
    userContext: { isNewAccount: false, messageCount: 30, isReply: true },
    text: 'дякую за допомогу'
  })
  // Either no verdict, or specifically a CLEAN verdict — never a spam one.
  if (verdict) assert.strictEqual(verdict.decision, 'clean', `wrongly flagged: ${verdict.rule}`)
})

test('verdict: trusted reputation → clean shortcut', () => {
  const userSignals = buildUserSignals(cleanUser, { id: cleanUser.telegram_id })
  const verdict = computeDeterministicVerdict({
    userSignals,
    quickAssessment: { risk: 'low', signals: [], trustSignals: [] },
    userContext: { isNewAccount: false, messageCount: 50, isReply: false },
    text: 'normal message'
  })
  assert.ok(verdict, 'trusted user must get a verdict')
  assert.strictEqual(verdict.decision, 'clean')
  assert.strictEqual(verdict.rule, 'trusted_reputation')
})

test('verdict: lols high spam factor + new account → spam shortcut', () => {
  const userSignals = buildUserSignals(spammerUser, { id: spammerUser.telegram_id })
  const verdict = computeDeterministicVerdict({
    userSignals,
    quickAssessment: { risk: 'medium', signals: ['text_url'], trustSignals: [] },
    userContext: { isNewAccount: true, messageCount: 1, isReply: false },
    text: 'check https://example.com'
  })
  assert.ok(verdict, 'should produce a verdict')
  assert.strictEqual(verdict.decision, 'spam')
})

test('verdict: mass-blast (low uniqueness, many messages) → spam', () => {
  const blaster = {
    globalStats: { totalMessages: 80, groupsActive: 6, spamDetections: 0, cleanMessages: 0, uniquenessRatio: 0.05, trackedMessages: 50 },
    reputation: { score: 50, status: 'neutral' },
    nameHistory: [],
    usernameHistory: [],
    externalBan: null,
    telegram_id: 7700000000
  }
  const userSignals = buildUserSignals(blaster, { id: blaster.telegram_id })
  const verdict = computeDeterministicVerdict({
    userSignals,
    quickAssessment: { risk: 'medium', signals: ['text_url'], trustSignals: [] },
    userContext: { isNewAccount: false, messageCount: 5, isReply: false },
    text: 'invest now https://bit.ly/xyz'
  })
  assert.ok(verdict, 'blaster should get a verdict')
  assert.strictEqual(verdict.decision, 'spam')
})

test('verdict: identity churn + new account + promo → spam', () => {
  const churner = {
    globalStats: { totalMessages: 5, groupsActive: 1, spamDetections: 0, cleanMessages: 0, uniquenessRatio: 1, trackedMessages: 5 },
    reputation: { score: 50, status: 'neutral' },
    nameHistory: [
      { value: 'Turbo', seenAt: new Date(Date.now() - 1 * 3600 * 1000) },
      { value: 'Smit', seenAt: new Date(Date.now() - 5 * 3600 * 1000) },
      { value: 'Alex', seenAt: new Date(Date.now() - 10 * 3600 * 1000) }
    ],
    usernameHistory: [],
    externalBan: null,
    telegram_id: 8800000001
  }
  const userSignals = buildUserSignals(churner, { id: churner.telegram_id })
  const verdict = computeDeterministicVerdict({
    userSignals,
    quickAssessment: { risk: 'medium', signals: ['text_url', 'inline_url_buttons'], trustSignals: [] },
    userContext: { isNewAccount: true, messageCount: 2, isReply: false },
    text: 'join now'
  })
  assert.ok(verdict, 'churner must get a verdict')
  assert.strictEqual(verdict.decision, 'spam')
})

// --------------------------------------------------------------------------
// Run
// --------------------------------------------------------------------------

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    t.fn()
    passed += 1
    console.log(`  ✓ ${t.name}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${t.name}`)
    console.log('     ' + err.message)
  }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
