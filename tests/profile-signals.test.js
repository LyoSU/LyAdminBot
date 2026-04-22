/**
 * Regression tests for helpers/profile-signals.js
 *
 * Run: node tests/profile-signals.test.js
 *
 * Inputs are pinned cases — handcrafted edge cases plus a frozen sample of
 * real production spam signatures. The goal is *not* recall measurement;
 * it's to make sure detector behavior doesn't silently drift when we change
 * thresholds or add new patterns.
 */

const assert = require('assert')
const {
  hasHomoglyphMix,
  usernameRandomnessScore,
  countNameEmoji,
  hasInvisibleChars,
  analyzeUrls,
  analyzeBio,
  countMentions,
  countHashtags,
  analyzeMessage,
  toSignalTags
} = require('../helpers/profile-signals')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// --------------------------------------------------------------------------
// Homoglyph
// --------------------------------------------------------------------------

test('homoglyph: Cyrillic + Latin within one token', () => {
  // Real banned-user examples from production
  assert.strictEqual(hasHomoglyphMix('Аlina'), true) // А Cyr + lina Lat
  assert.strictEqual(hasHomoglyphMix('Иoсифович'), true) // Latin o inside Cyr
  assert.strictEqual(hasHomoglyphMix('Mарина Сафронова'), true)
})

test('homoglyph: bilingual users (Cyr + Lat in different tokens) NOT flagged', () => {
  assert.strictEqual(hasHomoglyphMix('Привіт hello'), false)
  assert.strictEqual(hasHomoglyphMix('Yuri Іванов'), false)
})

test('homoglyph: empty / single-char tokens', () => {
  assert.strictEqual(hasHomoglyphMix(''), false)
  assert.strictEqual(hasHomoglyphMix(null), false)
  assert.strictEqual(hasHomoglyphMix('Я'), false)
})

// --------------------------------------------------------------------------
// Username randomness
// --------------------------------------------------------------------------

test('username randomness: bot-like handles score >= 0.7', () => {
  // Real banned-user examples
  assert.ok(usernameRandomnessScore('mkrvsk') >= 0.7)
  assert.ok(usernameRandomnessScore('knchk_pht') >= 0.7)
  assert.ok(usernameRandomnessScore('bbbrr1s') >= 0.7)
})

test('username randomness: normal handles stay below 0.7', () => {
  assert.ok(usernameRandomnessScore('pavel_durov') < 0.7)
  assert.ok(usernameRandomnessScore('alice_smith') < 0.7)
  assert.ok(usernameRandomnessScore('john123') < 0.7)
  assert.ok(usernameRandomnessScore(null) === 0)
  assert.ok(usernameRandomnessScore('@lo') === 0) // too short
})

// --------------------------------------------------------------------------
// Name emoji
// --------------------------------------------------------------------------

test('count name emoji', () => {
  assert.strictEqual(countNameEmoji('💐 🌴🌹🌹💐'), 5)
  assert.strictEqual(countNameEmoji('Pavel'), 0)
  assert.strictEqual(countNameEmoji(null), 0)
})

// --------------------------------------------------------------------------
// Invisible chars
// --------------------------------------------------------------------------

test('invisible chars: zero-width and RTL/LTR overrides', () => {
  assert.strictEqual(hasInvisibleChars('hello​world'), true) // ZWSP
  assert.strictEqual(hasInvisibleChars('test‮evil'), true) // RTL override
  assert.strictEqual(hasInvisibleChars('normal text'), false)
  assert.strictEqual(hasInvisibleChars(''), false)
})

// --------------------------------------------------------------------------
// URLs
// --------------------------------------------------------------------------

test('private invite link detection', () => {
  // Real spam pattern from production: "➡️➡️ https://t.me/+2yLrF2wOQ8UyMDMy ⬅️⬅️"
  assert.strictEqual(analyzeUrls('check this https://t.me/+2yLrF2wOQ8UyMDMy now').privateInvites, 1)
  assert.strictEqual(analyzeUrls('https://telegram.me/joinchat/AAAAAEX').privateInvites, 1)
  // Public username NOT flagged
  assert.strictEqual(analyzeUrls('https://t.me/durov').privateInvites, 0)
})

test('bot deeplink detection', () => {
  // Real pattern: "https://t.me/asjhdaskhd_bot?start=asjkd1a"
  const r = analyzeUrls('try https://t.me/some_bot?start=ref123')
  assert.strictEqual(r.botDeeplinks, 1)
})

test('url shortener detection', () => {
  const r = analyzeUrls('check https://bit.ly/abc and https://cutt.ly/xyz')
  assert.strictEqual(r.shorteners, 2)
})

test('punycode detection', () => {
  const r = analyzeUrls('https://xn--paypa-3eb.com/login')
  assert.strictEqual(r.punycode, 1)
})

test('distinct hosts counter', () => {
  const r = analyzeUrls('https://a.com and https://b.com and https://a.com again')
  assert.strictEqual(r.distinctHosts, 2)
})

// --------------------------------------------------------------------------
// Bio
// --------------------------------------------------------------------------

test('bio analysis: structural promo (URL + mention)', () => {
  const bio = analyzeBio('Our signals @signal_bot https://t.me/+joinme')
  assert.ok(bio.urls.total >= 1)
  assert.ok(bio.mentions >= 1)
  assert.strictEqual(bio.structuralPromo, true)
})

test('bio analysis: 2+ mentions triggers structural promo', () => {
  const bio = analyzeBio('Follow @alpha @beta @gamma for updates')
  assert.ok(bio.mentions >= 2)
  assert.strictEqual(bio.structuralPromo, true)
})

test('bio analysis: plain-text self-description is NOT structural promo', () => {
  const bio = analyzeBio('Hi, I am a student from Kyiv interested in photography and travel')
  assert.strictEqual(bio.structuralPromo, false)
})

test('bio analysis: empty', () => {
  assert.strictEqual(analyzeBio(null), null)
  assert.strictEqual(analyzeBio(''), null)
})

// --------------------------------------------------------------------------
// Message-level counters
// --------------------------------------------------------------------------

test('mention chain', () => {
  // Use realistic 3+ char usernames (TG minimum is 5; we accept 3+ to be safe)
  assert.strictEqual(countMentions('@alice @bobby @carol @dave1 @evepay get rich'), 5)
  assert.strictEqual(countMentions('hi @durov'), 1)
  assert.strictEqual(countMentions('@aa too short'), 0)
})

test('hashtag stack', () => {
  // Real spam: "#онлайн #работастелефона #удаленнаяработа #работаонлайн"
  assert.ok(countHashtags('#онлайн #работа #earn #invest #money') === 5)
})

// --------------------------------------------------------------------------
// Composite analyzeMessage + toSignalTags
// --------------------------------------------------------------------------

test('analyzeMessage: real spam pattern → expected signals', () => {
  const ctx = {
    from: { id: 12345, first_name: 'Promo', username: 'getrichquick' },
    message: { text: 'Join: https://t.me/+abcDEFghi free money @user1 @user2 @user3 @user4 @user5' }
  }
  const a = analyzeMessage(ctx, null, null)
  const { signals } = toSignalTags(a)
  assert.ok(signals.includes('private_invite_link'), 'should flag private invite')
  assert.ok(signals.includes('mention_chain'), 'should flag mention chain')
})

test('analyzeMessage: clean conversational message → no signals', () => {
  const ctx = {
    from: { id: 12345, first_name: 'Pavel', username: 'pavel_durov' },
    message: { text: 'Привіт всім, як справи?' }
  }
  const a = analyzeMessage(ctx, null, null)
  const { signals } = toSignalTags(a)
  assert.deepStrictEqual(signals, [], `unexpected signals: ${signals.join(', ')}`)
})

test('analyzeMessage: graceful when chatInfo missing (user never DM\'d bot)', () => {
  const ctx = { from: { id: 1, first_name: 'X' }, message: { text: 'hi' } }
  const out = analyzeMessage(ctx, null, null)
  assert.strictEqual(out.bio, null)
  assert.strictEqual(out.activeUsernames, 0)
  assert.strictEqual(out.hasPrivateForwards, false)
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
