/**
 * Reputation regression tests — covers review fixes that previously had no
 * coverage: hard-ceiling for banned users, repeat-offender ban trigger,
 * legacy backwards-compat path.
 */

const assert = require('assert')
const {
  calculateReputationScore,
  calculateReputation,
  getReputationStatus,
  processSpamAction
} = require('../helpers/reputation')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// --------------------------------------------------------------------------
// Hard ceiling for banned accounts
// --------------------------------------------------------------------------

test('hard ceiling: globally banned user score capped to 10', () => {
  const stats = { totalMessages: 1000, groupsActive: 5, spamDetections: 0, cleanMessages: 200 }
  // Without ban — high score
  const free = calculateReputationScore(stats, { months: 36, isExtrapolated: false })
  assert.ok(free >= 75, `expected high score for clean active user, got ${free}`)
  // With ban — capped
  const banned = calculateReputationScore(stats, { months: 36, isExtrapolated: false }, { isGlobalBanned: true })
  assert.ok(banned <= 10, `expected score capped to <=10 for banned user, got ${banned}`)
})

test('getReputationStatus: banned + capped score → restricted', () => {
  // Score 10 with banned flag should map to 'restricted'.
  assert.strictEqual(getReputationStatus(10), 'restricted')
  assert.strictEqual(getReputationStatus(0), 'restricted')
})

// --------------------------------------------------------------------------
// External ban as soft penalty (not authoritative)
// --------------------------------------------------------------------------

test('lols soft penalty: not enough alone to flip status to restricted', () => {
  const stats = { totalMessages: 500, groupsActive: 4, spamDetections: 0, cleanMessages: 100 }
  const score = calculateReputationScore(stats, { months: 24, isExtrapolated: false }, {
    externalBan: { lols: { banned: true, spamFactor: 0.7 } }
  })
  // High base, lols penalty -15 (banned) -7 (factor*10), still well above restricted.
  assert.ok(score > 30, `lols soft penalty alone should not crash a healthy account, got ${score}`)
})

// --------------------------------------------------------------------------
// processSpamAction triggers
// --------------------------------------------------------------------------

test('processSpamAction: high-confidence first detection triggers globalBan', () => {
  const userInfo = {
    isGlobalBanned: false,
    globalStats: { totalMessages: 5, spamDetections: 0 },
    reputation: { score: 50, status: 'neutral' }
  }
  const r = processSpamAction(userInfo, {
    userId: 99,
    messageDeleted: true,
    confidence: 92,
    muteSuccess: true,
    globalBanEnabled: true
  })
  assert.strictEqual(r.globalBanApplied, true)
  assert.strictEqual(userInfo.isGlobalBanned, true)
  // Hard ceiling applied immediately (review-fix #1).
  assert.ok(userInfo.reputation.score <= 10,
    `score must reflect ban on first detection, got ${userInfo.reputation.score}`)
})

test('processSpamAction: 5+ detections trigger globalBan even without mute', () => {
  const userInfo = {
    isGlobalBanned: false,
    globalStats: { totalMessages: 100, spamDetections: 4 },
    reputation: { score: 30, status: 'suspicious' }
  }
  const r = processSpamAction(userInfo, {
    userId: 99,
    messageDeleted: false,
    confidence: 75, // below 85 threshold
    muteSuccess: false,
    globalBanEnabled: true
  })
  // 4 prior + 1 current = 5 → repeat-offender trigger
  assert.strictEqual(r.globalBanApplied, true)
  assert.strictEqual(userInfo.isGlobalBanned, true)
  assert.match(userInfo.globalBanReason || '', /Repeat offender/)
})

test('processSpamAction: globalBanEnabled=false respects setting', () => {
  const userInfo = {
    isGlobalBanned: false,
    globalStats: { totalMessages: 5, spamDetections: 0 },
    reputation: { score: 50, status: 'neutral' }
  }
  const r = processSpamAction(userInfo, {
    userId: 99,
    messageDeleted: true,
    confidence: 95,
    muteSuccess: true,
    globalBanEnabled: false
  })
  assert.strictEqual(r.globalBanApplied, false)
  assert.strictEqual(userInfo.isGlobalBanned, false)
})

// --------------------------------------------------------------------------
// Backwards compatibility — legacy doc with bare fields
// --------------------------------------------------------------------------

test('legacy doc: calculateReputation handles missing fields', () => {
  const bare = {} // no totalMessages, no anything
  const rep = calculateReputation(bare, 123456789)
  assert.ok(Number.isFinite(rep.score))
  assert.ok(['trusted', 'neutral', 'suspicious', 'restricted'].includes(rep.status))
})

test('legacy doc: extras default does not throw', () => {
  // calculateReputation called without extras (old signature) must still work.
  assert.doesNotThrow(() => calculateReputation({ totalMessages: 0 }, 1))
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
