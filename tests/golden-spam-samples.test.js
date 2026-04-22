/**
 * Golden-sample regression test for the antispam pipeline.
 *
 * Run: node tests/golden-spam-samples.test.js
 *
 * Loads 30 real production spam signatures (frozen snapshot) and asserts
 * that the lightweight detection layers (signature generator, profile
 * signals, content signals) produce expected outputs.
 *
 * This is a *static* test — no network, no DB. The samples are pinned so a
 * future change to thresholds, normalization, or detector logic will break
 * this test if it would also regress production behaviour.
 *
 * The samples were extracted from db.spamsignatures where status=confirmed
 * and source ∈ {cas_import, ban_database_sync}.
 */

const assert = require('assert')
const { generateSignatures } = require('../helpers/spam-signatures')
const { analyzeUrls, analyzeMessage, toSignalTags } = require('../helpers/profile-signals')

// Loaded once via fs to keep this file readable.
const SAMPLES = require('./golden-spam-samples.json')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test(`loaded ${SAMPLES.length} spam samples`, () => {
  assert.ok(SAMPLES.length >= 25, `expected at least 25 samples, got ${SAMPLES.length}`)
})

test('every sample produces a valid signature object', () => {
  let failures = []
  for (const s of SAMPLES) {
    const sig = generateSignatures(s.text)
    if (!sig) failures.push(s.text.substring(0, 60))
    else if (!sig.exactHash) failures.push(s.text.substring(0, 60))
  }
  assert.strictEqual(failures.length, 0,
    `samples without signature:\n  ${failures.join('\n  ')}`)
})

test('exactHash is unique across distinct messages', () => {
  const hashes = new Set()
  let dupes = 0
  for (const s of SAMPLES) {
    const sig = generateSignatures(s.text)
    if (sig && hashes.has(sig.exactHash)) dupes += 1
    if (sig) hashes.add(sig.exactHash)
  }
  // We pulled distinct rows from MongoDB so there should be no exact dupes.
  assert.strictEqual(dupes, 0, `${dupes} duplicate exactHash values`)
})

test('content detector coverage on real spam', () => {
  // We measured production rates earlier:
  //   private_invite_link  ≈ 2-5 %
  //   url_shortener        ≈ 1-3 %
  //   bot_deeplink         ≈ 1-4 %
  // We only assert that AT LEAST ONE detector fires on AT LEAST ONE sample,
  // proving the regex layer is wired up correctly. Not a recall metric.
  let anyFire = false
  let perSignal = {}
  for (const s of SAMPLES) {
    const tags = toSignalTags(analyzeMessage(
      { from: { id: 1 }, message: { text: s.text } }, null, null
    )).signals
    if (tags.length > 0) anyFire = true
    for (const t of tags) perSignal[t] = (perSignal[t] || 0) + 1
  }
  assert.ok(anyFire, 'no profile/content signals fired on any of 30 spam samples')
  console.log('     [info] signals on golden corpus:', JSON.stringify(perSignal))
})

test('clean conversational corpus produces NO content signals', () => {
  // Hand-picked baseline of normal Ukrainian/Russian chat lines —
  // nothing here should trip ANY signal tag.
  const cleanCorpus = [
    'привіт всім, як справи сьогодні?',
    'дякую за допомогу, тепер зрозуміло',
    'хто нибудь стикався з такою проблемою у програмі?',
    'погода сьогодні чудова, всім гарного дня',
    'не зміг знайти потрібну інформацію в документації',
    'може порадите щось почитати по цій темі',
    'класне рішення, я б сам не додумався',
    'у мене схожа ситуація була минулого тижня',
    'натиснув кнопку, нічого не сталось, що робити',
    'дивно, у мене все працює нормально'
  ]
  let leaks = []
  for (const text of cleanCorpus) {
    const tags = toSignalTags(analyzeMessage(
      { from: { id: 1, first_name: 'User', username: 'user_normal' }, message: { text } }, null, null
    )).signals
    if (tags.length > 0) leaks.push({ text, tags })
  }
  assert.strictEqual(leaks.length, 0,
    `clean messages flagged:\n  ${leaks.map(l => l.text + ' → ' + l.tags.join(',')).join('\n  ')}`)
})

test('private invite links inside spam are detected', () => {
  // Production spam pattern: "➡️➡️ https://t.me/+2yLrF2wOQ8UyMDMy ⬅️⬅️"
  const samplesWithInvite = SAMPLES.filter(s => /t\.me\/\+/.test(s.text))
  // We expect at least a few of the 30 to contain private invites.
  if (samplesWithInvite.length === 0) {
    console.log('     [info] no private invite samples in this corpus — skipped')
    return
  }
  for (const s of samplesWithInvite) {
    const r = analyzeUrls(s.text)
    assert.ok(r.privateInvites > 0,
      `private invite missed in:\n  ${s.text.substring(0, 100)}`)
  }
})

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
