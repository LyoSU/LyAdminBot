const assert = require('assert')
const rf = require('../helpers/reaction-feedback')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const neg = (emoji) => ({ type: 'emoji', emoji })
const pos = (emoji) => ({ type: 'emoji', emoji })

// ---------- classifyUpdate ----------

test('classifyUpdate: empty old + negative new = addedNegative', () => {
  const r = rf.classifyUpdate({ old_reaction: [], new_reaction: [neg('💩')] })
  assert.strictEqual(r.addedNegative, true)
  assert.ok(r.negativeWeight > 0)
})

test('classifyUpdate: empty old + positive new = addedPositive', () => {
  const r = rf.classifyUpdate({ old_reaction: [], new_reaction: [pos('👍')] })
  assert.strictEqual(r.addedPositive, true)
})

test('classifyUpdate: removing a reaction is NOT an addition', () => {
  const r = rf.classifyUpdate({ old_reaction: [neg('💩')], new_reaction: [] })
  assert.strictEqual(r.addedNegative, false)
})

test('classifyUpdate: weighted 💩🤮 > 👎 > 🤡', () => {
  const poop = rf.classifyUpdate({ old_reaction: [], new_reaction: [neg('💩')] }).negativeWeight
  const thumbs = rf.classifyUpdate({ old_reaction: [], new_reaction: [neg('👎')] }).negativeWeight
  const clown = rf.classifyUpdate({ old_reaction: [], new_reaction: [neg('🤡')] }).negativeWeight
  assert.ok(poop > thumbs && thumbs > clown, `${poop} > ${thumbs} > ${clown}`)
})

// ---------- negativeEscalation ----------

test('negativeEscalation fires at 3 trusted users with weight>=3', () => {
  rf._resetForTests()
  const cls = rf.classifyUpdate({ old_reaction: [], new_reaction: [neg('👎')] })
  rf.recordReaction(-1, 100, { userId: 1, trusted: true, tenureMessages: 50, reputationScore: 70 }, cls)
  rf.recordReaction(-1, 100, { userId: 2, trusted: true, tenureMessages: 60, reputationScore: 70 }, cls)
  const v3 = rf.recordReaction(-1, 100, { userId: 3, trusted: true, tenureMessages: 70, reputationScore: 70 }, cls)
  assert.ok(v3 && v3.negativeEscalation, 'expected escalation on third trusted reactor')
})

test('negativeEscalation does NOT fire without trusted quorum', () => {
  rf._resetForTests()
  const cls = rf.classifyUpdate({ old_reaction: [], new_reaction: [neg('👎')] })
  // 5 untrusted reactors
  for (let i = 1; i <= 5; i++) {
    const v = rf.recordReaction(-1, 101, { userId: i, trusted: false, tenureMessages: 50, reputationScore: 70 }, cls)
    assert.ok(!v || !v.negativeEscalation, `must not escalate at user ${i}`)
  }
})

// ---------- harassment brigading ----------

test('harassmentBrigading fires on 3+ low-tenure/low-rep in <=5s burst', () => {
  rf._resetForTests()
  const cls = rf.classifyUpdate({ old_reaction: [], new_reaction: [neg('🤡')] })
  rf.recordReaction(-2, 200, { userId: 11, trusted: false, tenureMessages: 2, reputationScore: 30 }, cls)
  rf.recordReaction(-2, 200, { userId: 12, trusted: false, tenureMessages: 1, reputationScore: 20 }, cls)
  const v3 = rf.recordReaction(-2, 200, { userId: 13, trusted: false, tenureMessages: 3, reputationScore: 25 }, cls)
  assert.ok(v3 && v3.harassmentBrigading, 'brigading expected')
})

test('harassmentBrigading suppresses negativeEscalation on same bucket', () => {
  rf._resetForTests()
  const cls = rf.classifyUpdate({ old_reaction: [], new_reaction: [neg('👎')] })
  // Trigger brigading with low-rep burst, then add trusted users
  rf.recordReaction(-3, 300, { userId: 21, trusted: false, tenureMessages: 0, reputationScore: 10 }, cls)
  rf.recordReaction(-3, 300, { userId: 22, trusted: false, tenureMessages: 0, reputationScore: 10 }, cls)
  rf.recordReaction(-3, 300, { userId: 23, trusted: false, tenureMessages: 0, reputationScore: 10 }, cls)
  // Now trusted users react — should NOT escalate because brigading is set
  const v = rf.recordReaction(-3, 300, { userId: 24, trusted: true, tenureMessages: 100, reputationScore: 80 }, cls)
  const v5 = rf.recordReaction(-3, 300, { userId: 25, trusted: true, tenureMessages: 100, reputationScore: 80 }, cls)
  assert.ok(!v || !v.negativeEscalation)
  assert.ok(!v5 || !v5.negativeEscalation, 'brigading must suppress later escalation on same bucket')
})

// ---------- amplification ring ----------

test('amplificationRing fires on 3+ low-tenure positives in <=3s burst', () => {
  rf._resetForTests()
  const cls = rf.classifyUpdate({ old_reaction: [], new_reaction: [pos('👍')] })
  rf.recordReaction(-4, 400, { userId: 31, trusted: false, tenureMessages: 1, reputationScore: 40 }, cls)
  rf.recordReaction(-4, 400, { userId: 32, trusted: false, tenureMessages: 2, reputationScore: 40 }, cls)
  const v = rf.recordReaction(-4, 400, { userId: 33, trusted: false, tenureMessages: 1, reputationScore: 40 }, cls)
  assert.ok(v && v.amplificationRing, 'amplification ring expected')
})

// ---------- positive trust boost ----------

test('positiveTrustBoost fires on 3 trusted positive reactors', () => {
  rf._resetForTests()
  const cls = rf.classifyUpdate({ old_reaction: [], new_reaction: [pos('❤️')] })
  rf.recordReaction(-5, 500, { userId: 41, trusted: true, tenureMessages: 200, reputationScore: 80 }, cls)
  rf.recordReaction(-5, 500, { userId: 42, trusted: true, tenureMessages: 300, reputationScore: 85 }, cls)
  const v = rf.recordReaction(-5, 500, { userId: 43, trusted: true, tenureMessages: 150, reputationScore: 75 }, cls)
  assert.ok(v && v.positiveTrustBoost, 'expected trust boost')
})

// ---------- controversy skip ----------

test('controversySkip fires when both sides have trusted quorum', () => {
  rf._resetForTests()
  const negCls = rf.classifyUpdate({ old_reaction: [], new_reaction: [neg('👎')] })
  const posCls = rf.classifyUpdate({ old_reaction: [], new_reaction: [pos('👍')] })
  rf.recordReaction(-6, 600, { userId: 51, trusted: true, tenureMessages: 100, reputationScore: 70 }, negCls)
  rf.recordReaction(-6, 600, { userId: 52, trusted: true, tenureMessages: 100, reputationScore: 70 }, negCls)
  rf.recordReaction(-6, 600, { userId: 53, trusted: true, tenureMessages: 100, reputationScore: 70 }, posCls)
  const v = rf.recordReaction(-6, 600, { userId: 54, trusted: true, tenureMessages: 100, reputationScore: 70 }, posCls)
  // Controversy is signaled; bucket refuses to escalate either side
  assert.ok(v && v.controversySkip, `controversy skip expected, got ${JSON.stringify(v)}`)
})

let passed = 0; let failed = 0
for (const t of tests) {
  try { t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
