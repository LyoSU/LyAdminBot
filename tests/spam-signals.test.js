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

// --------------------------------------------------------------------------
// Review-driven regression tests
// --------------------------------------------------------------------------

test('verdict (C4): trusted user posting promo content does NOT get clean shortcut', () => {
  // A compromised trusted account posting a text URL or cashtag must fall
  // through to LLM/vector phases — not get a 98%-clean rubber-stamp.
  const userSignals = buildUserSignals(cleanUser, { id: cleanUser.telegram_id })
  const verdict = computeDeterministicVerdict({
    userSignals,
    quickAssessment: { risk: 'medium', signals: ['text_url'], trustSignals: [] },
    userContext: { isNewAccount: false, messageCount: 30, isReply: false },
    text: 'check my new project https://example.com'
  })
  // Either no verdict or definitely NOT a trusted-clean shortcut.
  if (verdict) {
    assert.notStrictEqual(verdict.rule, 'trusted_reputation', 'trusted-bypass must not fire on promo content')
  }
})

test('verdict (C3): single benign username change + plain link does NOT trigger compromised rule', () => {
  // Pre-fix this would FP: user changes their username (legitimate), posts
  // a normal link → confidence 88 ban. Now requires 2+ churn events AND a
  // strong promo signal (private invite / shortener / bot deeplink).
  const benignRename = {
    globalStats: { totalMessages: 50, groupsActive: 3, spamDetections: 0, cleanMessages: 20, uniquenessRatio: 0.95, trackedMessages: 50 },
    reputation: { score: 65, status: 'neutral' },
    nameHistory: [
      { value: 'Maria N', seenAt: new Date(Date.now() - 1 * 3600 * 1000) },
      { value: 'Maria', seenAt: new Date(Date.now() - 365 * 24 * 3600 * 1000) }
    ],
    usernameHistory: [
      { value: 'maria_new', seenAt: new Date(Date.now() - 1 * 3600 * 1000) },
      { value: 'maria_old', seenAt: new Date(Date.now() - 365 * 24 * 3600 * 1000) }
    ],
    externalBan: null,
    telegram_id: 123
  }
  const userSignals = buildUserSignals(benignRename, { id: 123 })
  const verdict = computeDeterministicVerdict({
    userSignals,
    quickAssessment: { risk: 'medium', signals: ['text_url'], trustSignals: [] },
    userContext: { isNewAccount: false, messageCount: 10, isReply: false },
    text: 'дивіться мій новий блог https://example.com'
  })
  if (verdict) {
    assert.notStrictEqual(verdict.rule, 'compromised_account_rebrand',
      'single benign rename + plain link must not be flagged as takeover')
  }
})

test('verdict (C3): compromised rule still fires on multi-rename + private invite', () => {
  // The strict version should still catch real takeovers.
  const compromised = {
    globalStats: { totalMessages: 200, groupsActive: 5, spamDetections: 0, cleanMessages: 100, uniquenessRatio: 0.9, trackedMessages: 50 },
    reputation: { score: 70, status: 'neutral' },
    nameHistory: [
      { value: 'PROMO_BOT', seenAt: new Date(Date.now() - 1 * 3600 * 1000) },
      { value: 'СрочнЫе_Кредиты', seenAt: new Date(Date.now() - 5 * 3600 * 1000) },
      { value: 'Олена', seenAt: new Date(Date.now() - 365 * 24 * 3600 * 1000) }
    ],
    usernameHistory: [
      { value: 'promo_2026', seenAt: new Date(Date.now() - 1 * 3600 * 1000) },
      { value: 'olena_real', seenAt: new Date(Date.now() - 365 * 24 * 3600 * 1000) }
    ],
    externalBan: null,
    telegram_id: 456
  }
  const userSignals = buildUserSignals(compromised, { id: 456 })
  const verdict = computeDeterministicVerdict({
    userSignals,
    quickAssessment: { risk: 'medium', signals: ['private_invite_link'], trustSignals: [] },
    userContext: { isNewAccount: false, messageCount: 50, isReply: false },
    text: 'крутий проект https://t.me/+abcDEF'
  })
  assert.ok(verdict, 'real takeover must trigger a verdict')
  assert.strictEqual(verdict.rule, 'compromised_account_rebrand')
})

test('verdict (I1): mass-blast does NOT misfire on intra-group power user', () => {
  // Single-group repeater (FAQ bot, support staff) shouldn't be flagged.
  const supportUser = {
    globalStats: { totalMessages: 200, groupsActive: 1, spamDetections: 0, cleanMessages: 100, uniquenessRatio: 0.05, trackedMessages: 50 },
    reputation: { score: 65, status: 'neutral' },
    nameHistory: [],
    usernameHistory: [],
    externalBan: null,
    telegram_id: 789
  }
  const userSignals = buildUserSignals(supportUser, { id: 789 })
  const verdict = computeDeterministicVerdict({
    userSignals,
    quickAssessment: { risk: 'medium', signals: ['text_url'], trustSignals: [] },
    userContext: { isNewAccount: false, messageCount: 100, isReply: false },
    text: 'see https://docs.example.com'
  })
  if (verdict) {
    assert.notStrictEqual(verdict.rule, 'mass_blast_low_uniqueness',
      'single-group repeater must not be flagged as blast spam')
  }
})

test('verdict (I2): lols high spamFactor on long-time lurker does NOT auto-ban', () => {
  // Pre-fix: <20 messages OR new account → SPAM. Now requires BOTH.
  // A 3-year-old account that lurked then started chatting has totalMessages
  // around 5 but isNewAccount=false. lols may have a stale flag on them.
  const lurker = {
    globalStats: { totalMessages: 5, groupsActive: 2, spamDetections: 0, cleanMessages: 0, uniquenessRatio: 1, trackedMessages: 0 },
    reputation: { score: 60, status: 'neutral' },
    nameHistory: [],
    usernameHistory: [],
    externalBan: { lols: { banned: false, spamFactor: 0.85, offenses: 1 } },
    telegram_id: 100000000 // pre-2018 ID, isNewAccount=false
  }
  const userSignals = buildUserSignals(lurker, { id: 100000000 })
  const verdict = computeDeterministicVerdict({
    userSignals,
    quickAssessment: { risk: 'low', signals: [], trustSignals: [] },
    userContext: { isNewAccount: false, messageCount: 1, isReply: false },
    text: 'привіт всім'
  })
  if (verdict) {
    assert.notStrictEqual(verdict.rule, 'lols_high_spam_factor',
      'long-time lurker must not auto-ban on lols spamFactor alone')
  }
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
