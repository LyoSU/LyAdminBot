/**
 * Tests for helpers/user-stats.js — behavioural aggregation layer.
 *
 * Covers:
 *   - Welford mean / variance correctness
 *   - Hour-of-day histogram increments using message.date
 *   - Entity counting + formatting diversity
 *   - Media type classification (canonical key per message)
 *   - Contact counter (dedicated separate accumulator)
 *   - Reply counter (with self-reply guard)
 *   - Language detection + top-N rolling update
 *   - Bio persistence + churn history cap
 *   - Custom-emoji ID harvesting from entities
 *   - Derived accessors (stdDev, replyRatio, hourZeroCount)
 */

const assert = require('assert')
const {
  recordMessageStats,
  recordBio,
  recordBusinessIntro,
  getMediaType,
  detectLanguage,
  getLengthStdDev,
  getReplyRatio,
  getHourZeroCount,
  getTopLanguage,
  welfordUpdate,
  ensureMessageStats
} = require('../helpers/user-stats')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const makeUser = () => ({
  telegram_id: 123,
  globalStats: { totalMessages: 0 }
})

const makeCtx = (overrides = {}) => {
  const message = overrides.message || { text: 'hello world' }
  return {
    from: overrides.from || { id: 123, first_name: 'Test' },
    chat: { id: -1, type: 'supergroup' },
    message
  }
}

// --------------------------------------------------------------------------
// Welford
// --------------------------------------------------------------------------

test('welford: single sample produces mean=x, variance=0', () => {
  const ms = ensureMessageStats({ globalStats: {} })
  welfordUpdate(ms, 1, 10)
  assert.strictEqual(ms.avgLength, 10)
  assert.strictEqual(ms.lengthM2, 0)
})

test('welford: mean of 10,20,30 is 20 with correct M2', () => {
  const ms = ensureMessageStats({ globalStats: {} })
  welfordUpdate(ms, 1, 10)
  welfordUpdate(ms, 2, 20)
  welfordUpdate(ms, 3, 30)
  assert.strictEqual(ms.avgLength, 20)
  // Sample variance ((10-20)^2 + (20-20)^2 + (30-20)^2) / (n-1) = 200/2 = 100
  assert.strictEqual(Math.round(ms.lengthM2 / 2), 100)
})

// --------------------------------------------------------------------------
// getMediaType
// --------------------------------------------------------------------------

test('getMediaType: text-only message', () => {
  assert.strictEqual(getMediaType({ text: 'hi' }), 'text')
})
test('getMediaType: voice beats other types', () => {
  assert.strictEqual(getMediaType({ voice: {}, text: 'x' }), 'voice')
})
test('getMediaType: video_note beats video', () => {
  assert.strictEqual(getMediaType({ video: {}, video_note: {} }), 'video_note')
})
test('getMediaType: contact message', () => {
  assert.strictEqual(getMediaType({ contact: { phone_number: '+1' } }), 'contact')
})
test('getMediaType: location message', () => {
  assert.strictEqual(getMediaType({ location: { latitude: 0 } }), 'location')
})
test('getMediaType: empty message', () => {
  assert.strictEqual(getMediaType({}), null)
})

// --------------------------------------------------------------------------
// recordMessageStats — integration
// --------------------------------------------------------------------------

test('recordMessageStats: text message updates length, hour, mediaCounts.text', () => {
  const user = makeUser()
  user.globalStats.totalMessages = 1
  const ctx = makeCtx({
    message: { text: 'Hello, how are you today?', date: Math.floor(Date.UTC(2025, 0, 1, 14, 30) / 1000) }
  })
  recordMessageStats(user, ctx)
  const ms = user.globalStats.messageStats
  assert.strictEqual(ms.avgLength, 25, 'length matches the actual text')
  assert.strictEqual(ms.hourHistogram[14], 1, 'hour 14 incremented for UTC 14:30')
  assert.strictEqual(ms.mediaCounts.text, 1)
})

test('recordMessageStats: photo message updates mediaCounts.photo', () => {
  const user = makeUser()
  user.globalStats.totalMessages = 1
  const ctx = makeCtx({
    message: { photo: [{ file_unique_id: 'abc' }], caption: 'see this', date: Math.floor(Date.now() / 1000) }
  })
  recordMessageStats(user, ctx)
  assert.strictEqual(user.globalStats.messageStats.mediaCounts.photo, 1)
  assert.strictEqual(user.globalStats.messageStats.mediaCounts.text, 0)
})

test('recordMessageStats: contact message increments contactCount', () => {
  const user = makeUser()
  user.globalStats.totalMessages = 1
  const ctx = makeCtx({
    message: { contact: { phone_number: '+60 173904335', first_name: 'Test' }, date: Math.floor(Date.now() / 1000) }
  })
  recordMessageStats(user, ctx)
  assert.strictEqual(user.globalStats.messageStats.mediaCounts.contact, 1)
  assert.strictEqual(user.globalStats.messageStats.contactCount, 1)
})

test('recordMessageStats: entity counts + formatting diversity', () => {
  const user = makeUser()
  user.globalStats.totalMessages = 1
  const ctx = makeCtx({
    message: {
      text: 'Check #hashtag @mention $USDT',
      entities: [
        { type: 'hashtag', offset: 6, length: 8 },
        { type: 'mention', offset: 15, length: 8 },
        { type: 'cashtag', offset: 24, length: 5 }
      ],
      date: Math.floor(Date.now() / 1000)
    }
  })
  recordMessageStats(user, ctx)
  const ms = user.globalStats.messageStats
  assert.strictEqual(ms.entityCounts.hashtag, 1)
  assert.strictEqual(ms.entityCounts.mention, 1)
  assert.strictEqual(ms.entityCounts.cashtag, 1)
  assert.strictEqual(ms.formattingDiversitySum, 3)
})

test('recordMessageStats: custom_emoji harvested into user.customEmojiIds', () => {
  const user = makeUser()
  user.globalStats.totalMessages = 1
  const ctx = makeCtx({
    message: {
      text: 'yo',
      entities: [
        { type: 'custom_emoji', offset: 0, length: 1, custom_emoji_id: '5361823234567891' }
      ],
      date: Math.floor(Date.now() / 1000)
    }
  })
  recordMessageStats(user, ctx)
  assert.ok(Array.isArray(user.customEmojiIds))
  assert.strictEqual(user.customEmojiIds.length, 1)
  assert.strictEqual(user.customEmojiIds[0].id, '5361823234567891')
  assert.strictEqual(user.customEmojiIds[0].count, 1)
})

test('recordMessageStats: reply counter excludes self-reply', () => {
  const user = makeUser()
  user.globalStats.totalMessages = 2
  // Non-self reply
  recordMessageStats(user, makeCtx({
    message: {
      text: 'hi',
      reply_to_message: { from: { id: 999 } },
      date: Math.floor(Date.now() / 1000)
    }
  }))
  // Self reply (ignored)
  recordMessageStats(user, makeCtx({
    message: {
      text: 'still me',
      reply_to_message: { from: { id: 123 } },
      date: Math.floor(Date.now() / 1000)
    }
  }))
  assert.strictEqual(user.globalStats.messageStats.replyCount, 1)
})

test('recordMessageStats: edit counter fires on editedMessage ctx', () => {
  const user = makeUser()
  user.globalStats.totalMessages = 1
  const ctx = {
    from: { id: 123, first_name: 'T' },
    chat: { id: -1, type: 'supergroup' },
    editedMessage: { text: 'edited now with link http://spam', date: Math.floor(Date.now() / 1000) }
  }
  recordMessageStats(user, ctx)
  assert.strictEqual(user.globalStats.messageStats.editCount, 1)
})

test('recordMessageStats: premium flag tracked', () => {
  const user = makeUser()
  user.globalStats.totalMessages = 1
  const ctx = makeCtx({
    from: { id: 123, first_name: 'T', is_premium: true, language_code: 'uk' },
    message: { text: 'hi', date: Math.floor(Date.now() / 1000) }
  })
  recordMessageStats(user, ctx)
  assert.strictEqual(user.isPremium, true)
  assert.strictEqual(user.languageCode, 'uk')
})

// --------------------------------------------------------------------------
// Language detection
// --------------------------------------------------------------------------

test('detectLanguage: obvious Ukrainian text', () => {
  const code = detectLanguage('Доброго дня, як справи з оформленням ВПО в Харкові?')
  assert.ok(code === 'uk' || code === 'ru' || code === 'be', `got ${code}`)
})

test('detectLanguage: obvious English text', () => {
  const code = detectLanguage('Hello everyone, how are you today? I hope you are doing well.')
  assert.strictEqual(code, 'en')
})

test('detectLanguage: too short → null', () => {
  assert.strictEqual(detectLanguage('hi'), null)
})

test('recordMessageStats: top detected language stored and incremented', () => {
  const user = makeUser()
  user.globalStats.totalMessages = 1
  recordMessageStats(user, makeCtx({ message: { text: 'Hello my friend how are you today in the morning?', date: Math.floor(Date.now() / 1000) } }))
  user.globalStats.totalMessages = 2
  recordMessageStats(user, makeCtx({ message: { text: 'Another message in english, clearly enough words.', date: Math.floor(Date.now() / 1000) } }))
  const top = getTopLanguage(user)
  assert.strictEqual(top, 'en')
})

// --------------------------------------------------------------------------
// Bio persistence
// --------------------------------------------------------------------------

test('recordBio: first bio creates snapshot, no history push', () => {
  const user = {}
  const r = recordBio(user, 'First time bio')
  assert.strictEqual(r.changed, true)
  assert.strictEqual(user.bio.text, 'First time bio')
  assert.strictEqual(user.bio.history.length, 0, 'first observation does not create history entry')
})

test('recordBio: subsequent change pushes previous to history', () => {
  const user = {}
  recordBio(user, 'original')
  recordBio(user, 'promo version crypto')
  assert.strictEqual(user.bio.text, 'promo version crypto')
  assert.strictEqual(user.bio.history.length, 1)
  assert.strictEqual(user.bio.history[0].value, 'original')
})

test('recordBio: same value → no change', () => {
  const user = { bio: { text: 'same', updatedAt: new Date(), history: [] } }
  const r = recordBio(user, 'same')
  assert.strictEqual(r.changed, false)
})

test('recordBio: history capped at 3', () => {
  const user = {}
  recordBio(user, 'a')
  recordBio(user, 'b')
  recordBio(user, 'c')
  recordBio(user, 'd')
  recordBio(user, 'e')
  assert.ok(user.bio.history.length <= 3, `cap exceeded: ${user.bio.history.length}`)
})

test('recordBusinessIntro: changes tracked', () => {
  const user = {}
  const r = recordBusinessIntro(user, 'Our crypto signals channel t.me/scam')
  assert.strictEqual(r.changed, true)
  assert.strictEqual(user.businessIntro.text, 'Our crypto signals channel t.me/scam')
})

// --------------------------------------------------------------------------
// Derived accessors
// --------------------------------------------------------------------------

test('getLengthStdDev: zero with <2 samples', () => {
  const user = { globalStats: { totalMessages: 1, messageStats: { avgLength: 10, lengthM2: 0 } } }
  assert.strictEqual(getLengthStdDev(user), 0)
})

test('getLengthStdDev: valid with 2+ samples', () => {
  const user = { globalStats: { totalMessages: 3, messageStats: { avgLength: 20, lengthM2: 200 } } }
  // sample variance = 200 / 2 = 100 → stdDev = 10
  assert.strictEqual(getLengthStdDev(user), 10)
})

test('getReplyRatio: null for new users', () => {
  assert.strictEqual(getReplyRatio({ globalStats: { totalMessages: 0, messageStats: { replyCount: 0 } } }), null)
})

test('getReplyRatio: correct fraction', () => {
  assert.strictEqual(
    getReplyRatio({ globalStats: { totalMessages: 10, messageStats: { replyCount: 3 } } }),
    0.3
  )
})

test('getHourZeroCount: human-like distribution', () => {
  const hist = new Array(24).fill(0)
  for (let h = 8; h < 22; h++) hist[h] = 2
  const user = { globalStats: { messageStats: { hourHistogram: hist } } }
  const zeros = getHourZeroCount(user)
  assert.strictEqual(zeros, 10, 'expected 10 sleep-hour zero buckets')
})

test('getHourZeroCount: 24/7 bot', () => {
  const user = { globalStats: { messageStats: { hourHistogram: new Array(24).fill(5) } } }
  assert.strictEqual(getHourZeroCount(user), 0)
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
