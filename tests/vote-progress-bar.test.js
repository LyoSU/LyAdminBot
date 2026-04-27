const assert = require('assert')
const { createI18n } = require('../bot/i18n')

const voteUI = require('../helpers/vote-ui')

const i18nLoader = createI18n()

const mkI18n = (lang = 'uk') => i18nLoader.createContext(lang)

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('progress lines: pure renderer returns title + bar', () => {
  const lines = voteUI.buildProgressLines({
    expiresAt: new Date(Date.now() + 4 * 60000 + 12000),
    voteTally: { spamWeighted: 1, cleanWeighted: 0 },
    i18n: mkI18n('uk')
  })
  assert.strictEqual(lines.length, 2)
  assert.ok(lines[0].includes('⚖️'), 'title row has scale emoji')
  assert.ok(/1 голосів/.test(lines[1]), 'bar row carries vote count (' + lines[1] + ')')
})

test('progress bar shape: 10 cells', () => {
  const lines = voteUI.buildProgressLines({
    expiresAt: new Date(Date.now() + 60000),
    voteTally: { spamWeighted: 0, cleanWeighted: 0 },
    i18n: mkI18n('en')
  })
  // Pull the contiguous run of █/░ characters out of the bar line.
  const m = lines[1].match(/[█░]+/)
  assert.ok(m, 'bar contains █/░ glyphs')
  assert.strictEqual(m[0].length, 10, 'bar is exactly 10 cells')
  assert.strictEqual(m[0], '░░░░░░░░░░', 'empty bar at 0 votes')
})

test('progress bar fills proportionally', () => {
  const lines = voteUI.buildProgressLines({
    expiresAt: new Date(Date.now() + 60000),
    voteTally: { spamWeighted: 1, cleanWeighted: 1 }, // 2 of 3
    i18n: mkI18n('en')
  })
  const m = lines[1].match(/[█░]+/)
  // 2/3 → 66.6% → round(6.66) = 7 cells filled
  assert.strictEqual(m[0], '███████░░░')
})

test('percent capped at 100% (extra votes do not overflow)', () => {
  const lines = voteUI.buildProgressLines({
    expiresAt: new Date(Date.now() + 60000),
    voteTally: { spamWeighted: 99, cleanWeighted: 0 },
    i18n: mkI18n('en')
  })
  const m = lines[1].match(/[█░]+/)
  assert.strictEqual(m[0], '██████████', 'overflow clamps to all-full')
  assert.ok(/3 votes/.test(lines[1]), 'votesIn capped at votesNeeded (' + lines[1] + ')')
})

test('expired voting renders zero remaining without throwing', () => {
  const lines = voteUI.buildProgressLines({
    expiresAt: new Date(Date.now() - 60000),
    voteTally: { spamWeighted: 0, cleanWeighted: 0 },
    i18n: mkI18n('en')
  })
  assert.strictEqual(lines.length, 2)
  // humanize-duration with 0ms in EN renders "0 seconds"
  assert.ok(/0/.test(lines[0]), 'title carries zeroed remaining (' + lines[0] + ')')
})

test('VOTES_NEEDED constant matches SpamVote.canResolve threshold', () => {
  assert.strictEqual(voteUI.VOTES_NEEDED, 3)
})

test('buildVoteKeyboard adds [🔍 Деталі] row routed to mod.vote.details', () => {
  const i18n = mkI18n('uk')
  const kb = voteUI.buildVoteNotification({
    eventId: 'abc123',
    bannedUserName: 'X',
    bannedUserUsername: null,
    userContext: {},
    aiConfidence: 80,
    aiReason: 'Inappropriate content',
    messagePreview: 'spam',
    expiresAt: new Date(Date.now() + 60000),
    voters: [],
    voteTally: { spamCount: 0, cleanCount: 0, spamWeighted: 0, cleanWeighted: 0 },
    actionTaken: { banned: false }
  }, i18n).keyboard
  assert.strictEqual(kb.inline_keyboard.length, 2, 'two rows: votes + details')
  const detailsRow = kb.inline_keyboard[1]
  assert.strictEqual(detailsRow.length, 1)
  assert.ok(detailsRow[0].text.includes('Деталі'))
  assert.ok(detailsRow[0].callback_data.startsWith('m:v1:mod.vote.details:open:abc123'))
})

test('buildPostResultKeyboard: spam-confirmed → [perma] + [unblock]', () => {
  const i18n = mkI18n('uk')
  const kb = voteUI.buildPostResultKeyboard('xyz', 'spam', i18n)
  assert.strictEqual(kb.inline_keyboard.length, 1)
  const flat = kb.inline_keyboard.flat()
  assert.strictEqual(flat.length, 2)
  assert.ok(flat[0].text.includes('назавжди'))
  assert.ok(flat[0].callback_data.includes('mod.event:perma:xyz'))
  assert.ok(flat[1].text.includes('Розблокувати'))
  assert.ok(flat[1].callback_data.includes('mod.event:undo:xyz'))
})

test('buildPostResultKeyboard: clean-confirmed → [still_ban] only', () => {
  const i18n = mkI18n('uk')
  const kb = voteUI.buildPostResultKeyboard('xyz', 'clean', i18n)
  const flat = kb.inline_keyboard.flat()
  assert.strictEqual(flat.length, 1)
  assert.ok(flat[0].text.includes('Все ж'))
  assert.ok(flat[0].callback_data.includes('mod.event:still_ban:xyz'))
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + (e.stack || e.message)) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
