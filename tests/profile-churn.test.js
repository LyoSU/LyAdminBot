/**
 * Profile-churn tests: bio escalation, business-intro structural promo.
 * All detectors are keyword-free — they operate on URL presence, mention
 * count, invisible chars, and character-class density.
 */

const assert = require('assert')
const {
  analyzeBioChurn,
  analyzeBusinessIntro,
  evaluateProfileChurn,
  isBioStructuralPromo
} = require('../helpers/profile-churn')
const { getAccountAgeParadox } = require('../helpers/account-age')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// --------------------------------------------------------------------------
// Bio structural promo
// --------------------------------------------------------------------------

test('isBioStructuralPromo: URL present → true', () => {
  assert.strictEqual(isBioStructuralPromo('Check https://example.com for details'), true)
})
test('isBioStructuralPromo: 2+ mentions → true', () => {
  assert.strictEqual(isBioStructuralPromo('Follow @alpha @beta @gamma'), true)
})
test('isBioStructuralPromo: plain text → false', () => {
  assert.strictEqual(isBioStructuralPromo('Hi I am a student in Kyiv studying maths'), false)
})
test('isBioStructuralPromo: empty → false', () => {
  assert.strictEqual(isBioStructuralPromo(''), false)
  assert.strictEqual(isBioStructuralPromo(null), false)
})

// --------------------------------------------------------------------------
// Bio churn
// --------------------------------------------------------------------------

test('analyzeBioChurn: null if no history', () => {
  assert.strictEqual(analyzeBioChurn({ bio: { text: 'current', history: [] } }), null)
  assert.strictEqual(analyzeBioChurn({}), null)
})

test('analyzeBioChurn: plain → promo bio change flagged', () => {
  const user = {
    bio: {
      text: 'Check https://t.me/+myref for earn opportunities',
      history: [{ value: 'just a student', seenAt: new Date() }]
    }
  }
  const r = analyzeBioChurn(user)
  assert.strictEqual(r.changedTo, true)
  assert.strictEqual(r.currentPromo, true)
  assert.strictEqual(r.previousPromo, false)
})

test('analyzeBioChurn: promo → plain is NOT flagged as promo change', () => {
  const user = {
    bio: {
      text: 'just studying again',
      history: [{ value: 'Buy now https://scam.com' }]
    }
  }
  const r = analyzeBioChurn(user)
  assert.strictEqual(r.changedTo, false)
})

test('analyzeBioChurn: still-promo history (both promo) is not flagged', () => {
  const user = {
    bio: {
      text: 'New link https://v2.example',
      history: [{ value: 'Old link https://v1.example' }]
    }
  }
  const r = analyzeBioChurn(user)
  assert.strictEqual(r.changedTo, false, 'both were promo — no new escalation')
})

// --------------------------------------------------------------------------
// Business intro
// --------------------------------------------------------------------------

test('analyzeBusinessIntro: absent → not promo', () => {
  const r = analyzeBusinessIntro({})
  assert.strictEqual(r.present, false)
  assert.strictEqual(r.structuralPromo, false)
})

test('analyzeBusinessIntro: plain intro → not promo', () => {
  const r = analyzeBusinessIntro({ businessIntro: { text: 'Small bakery in downtown.' } })
  assert.strictEqual(r.present, true)
  assert.strictEqual(r.structuralPromo, false)
})

test('analyzeBusinessIntro: URL in intro → promo', () => {
  const r = analyzeBusinessIntro({ businessIntro: { text: 'Visit https://our-shop.example' } })
  assert.strictEqual(r.structuralPromo, true)
})

test('analyzeBusinessIntro: invisible chars → promo', () => {
  const r = analyzeBusinessIntro({ businessIntro: { text: 'Hidden​content' } })
  assert.strictEqual(r.structuralPromo, true)
})

// --------------------------------------------------------------------------
// evaluateProfileChurn — combined verdict
// --------------------------------------------------------------------------

test('evaluateProfileChurn: bio_churn_new_promo fires on URL escalation', () => {
  // New bio contains a URL → structural promo. Previous bio was plain.
  // The escalation is what the rule catches — "suddenly has a link".
  const r = evaluateProfileChurn({
    bio: {
      text: 'Visit https://t.me/+myref for daily updates',
      history: [{ value: 'student from Kyiv' }]
    }
  })
  assert.ok(r.verdict, 'expected a verdict')
  assert.strictEqual(r.verdict.rule, 'bio_churn_new_promo')
  assert.ok(r.signals.includes('bio_churn_to_promo'))
})

test('evaluateProfileChurn: bio_churn fires on mention-chain escalation', () => {
  const r = evaluateProfileChurn({
    bio: {
      text: 'Follow @alpha @beta @gamma',
      history: [{ value: 'student in Kyiv' }]
    }
  })
  assert.ok(r.verdict)
  assert.strictEqual(r.verdict.rule, 'bio_churn_new_promo')
})

test('evaluateProfileChurn: business_intro_promo fires standalone', () => {
  const r = evaluateProfileChurn({
    businessIntro: { text: 'Join t.me/bigchannel and @helper' }
  })
  assert.ok(r.verdict)
  assert.strictEqual(r.verdict.rule, 'business_intro_promo')
})

test('evaluateProfileChurn: no verdict without structural promo', () => {
  const r = evaluateProfileChurn({
    bio: { text: 'studying', history: [{ value: 'also studying' }] },
    businessIntro: { text: 'Small local shop' }
  })
  assert.strictEqual(r.verdict, null)
})

// --------------------------------------------------------------------------
// Account-age paradox
// --------------------------------------------------------------------------

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

test('getAccountAgeParadox: veteran ID + just-seen → isSleeperAwakened', () => {
  // Use a known pre-2020 anchor id so predictedCreation is confidently old
  const oldId = 500000000
  const firstSeen = new Date(Date.now() - 24 * 60 * 60 * 1000) // 1 day ago
  const r = getAccountAgeParadox(oldId, firstSeen)
  assert.ok(r, 'paradox result should exist')
  assert.ok(r.predictedAgeDays > 365, `predicted ${r.predictedAgeDays} days`)
  assert.ok(r.localAgeDays < 7)
  assert.strictEqual(r.isSleeperAwakened, true)
  assert.strictEqual(r.isFreshBake, false)
})

test('getAccountAgeParadox: fresh ID + just-seen → isFreshBake', () => {
  // An id far beyond known anchors — extrapolation caps at now, so predicted
  // age collapses to ~0 days. Any id >= 15B is safely "now or later" relative
  // to the current anchor data (last entry is 6.9B at Nov 2024).
  const freshId = 15000000000
  const firstSeen = new Date(Date.now() - 12 * 60 * 60 * 1000)
  const r = getAccountAgeParadox(freshId, firstSeen)
  assert.ok(r)
  assert.strictEqual(r.isSleeperAwakened, false)
  assert.strictEqual(r.isFreshBake, true)
})

test('getAccountAgeParadox: long-established local user → neither flag', () => {
  const oldId = 500000000
  const firstSeen = new Date(Date.now() - 3 * YEAR_MS)
  const r = getAccountAgeParadox(oldId, firstSeen)
  assert.strictEqual(r.isSleeperAwakened, false)
  assert.strictEqual(r.isFreshBake, false)
})

test('getAccountAgeParadox: invalid input → null', () => {
  assert.strictEqual(getAccountAgeParadox(null, new Date()), null)
  assert.strictEqual(getAccountAgeParadox(1, null), null)
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
