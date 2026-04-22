const assert = require('assert')
const {
  isTrustedFastPathEligible,
  TRUSTED_FAST_PATH_MIN_REPUTATION,
  TRUSTED_FAST_PATH_MIN_MESSAGES
} = require('../helpers/spam-check')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// Prototype "trusted" userInfo — flip fields in individual tests to cover
// each rejection path without repeating the setup.
const trustedUser = () => ({
  reputation: { score: 90, status: 'neutral' },
  globalStats: { totalMessages: 50, spamDetections: 0 }
})
const cleanAssessment = () => ({
  risk: 'low',
  signals: [],
  trustSignals: ['established_user']
})

test('baseline: high rep + no signals → eligible', () => {
  assert.strictEqual(isTrustedFastPathEligible(trustedUser(), cleanAssessment()), true)
})

test('reputation just below threshold → NOT eligible', () => {
  const u = trustedUser()
  u.reputation.score = TRUSTED_FAST_PATH_MIN_REPUTATION - 1
  assert.strictEqual(isTrustedFastPathEligible(u, cleanAssessment()), false)
})

test('reputation exactly at threshold → eligible', () => {
  const u = trustedUser()
  u.reputation.score = TRUSTED_FAST_PATH_MIN_REPUTATION
  assert.strictEqual(isTrustedFastPathEligible(u, cleanAssessment()), true)
})

test('totalMessages below threshold → NOT eligible', () => {
  const u = trustedUser()
  u.globalStats.totalMessages = TRUSTED_FAST_PATH_MIN_MESSAGES - 1
  assert.strictEqual(isTrustedFastPathEligible(u, cleanAssessment()), false)
})

test('any prior spamDetection → NOT eligible', () => {
  const u = trustedUser()
  u.globalStats.spamDetections = 1
  assert.strictEqual(isTrustedFastPathEligible(u, cleanAssessment()), false)
})

test('any quick-risk signal → NOT eligible (even with high trust)', () => {
  const qa = cleanAssessment()
  qa.signals = ['dormancy_burst_off_hour']
  assert.strictEqual(isTrustedFastPathEligible(trustedUser(), qa), false)
})

test('risk classified higher than low → NOT eligible', () => {
  const qa = cleanAssessment()
  qa.risk = 'medium'
  assert.strictEqual(isTrustedFastPathEligible(trustedUser(), qa), false)
})

test('missing userInfo → NOT eligible (no crash)', () => {
  assert.strictEqual(isTrustedFastPathEligible(null, cleanAssessment()), false)
  assert.strictEqual(isTrustedFastPathEligible(undefined, cleanAssessment()), false)
  assert.strictEqual(isTrustedFastPathEligible({}, cleanAssessment()), false)
})

test('missing quickAssessment → NOT eligible (no crash)', () => {
  assert.strictEqual(isTrustedFastPathEligible(trustedUser(), null), false)
  assert.strictEqual(isTrustedFastPathEligible(trustedUser(), undefined), false)
})

test('non-array signals → NOT eligible (defensive)', () => {
  const qa = cleanAssessment()
  qa.signals = 'not an array'
  assert.strictEqual(isTrustedFastPathEligible(trustedUser(), qa), false)
})

let passed = 0; let failed = 0
for (const t of tests) {
  try { t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
