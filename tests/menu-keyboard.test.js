const assert = require('assert')
const {
  btn, row, backBtn, closeBtn, toggleBtn, paginated, confirmKeyboard, cb
} = require('../helpers/menu/keyboard')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('cb builds m:v1: prefixed callback_data', () => {
  assert.strictEqual(cb('settings', 'open'), 'm:v1:settings:open')
  assert.strictEqual(cb('ban', 'do', '123', '300'), 'm:v1:ban:do:123:300')
})

test('cb throws in non-production when payload exceeds 64 bytes', () => {
  const long = 'x'.repeat(80)
  assert.throws(() => cb('s', 'a', long), /exceeds 64 bytes/)
})

test('cb safely truncates in production when payload exceeds 64 bytes', () => {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const long = 'x'.repeat(80)
    const result = cb('s', 'a', long)
    assert.ok(Buffer.byteLength(result, 'utf8') <= 64)
    // truncation must produce valid UTF-8 (no split multibyte chars)
    const emoji = '🎉'.repeat(20) // 4 bytes each = 80 bytes total
    const r2 = cb('s', 'a', emoji)
    assert.doesNotThrow(() => Buffer.from(r2, 'utf8').toString('utf8'))
  } finally {
    process.env.NODE_ENV = prev
  }
})

test('btn builds an inline button object', () => {
  assert.deepStrictEqual(btn('Hi', 'm:v1:x:y'), { text: 'Hi', callback_data: 'm:v1:x:y' })
})

test('btn passes icon_custom_emoji_id when provided', () => {
  assert.deepStrictEqual(
    btn('Hi', 'd', { iconEmojiId: '123' }),
    { text: 'Hi', callback_data: 'd', icon_custom_emoji_id: '123' }
  )
})

test('btn passes url instead of callback_data when given', () => {
  assert.deepStrictEqual(btn('Open', null, { url: 'https://t.me' }), { text: 'Open', url: 'https://t.me' })
})

test('btn throws when neither url nor callback_data provided', () => {
  assert.throws(() => btn('Bad', null), /missing both callback_data and opts.url/)
  assert.throws(() => btn('Bad', undefined), /missing both callback_data and opts.url/)
})

test('row wraps buttons into an array', () => {
  const a = btn('A', 'a'); const b = btn('B', 'b')
  assert.deepStrictEqual(row(a, b), [a, b])
})

test('row filters falsy entries (so callers can use conditionals)', () => {
  const a = btn('A', 'a')
  assert.deepStrictEqual(row(a, false, null, undefined), [a])
})

test('backBtn produces a back button to a target screen', () => {
  const b = backBtn('settings.root')
  assert.strictEqual(b.text, '← Назад')
  assert.strictEqual(b.callback_data, 'm:v1:settings.root:open')
})

test('backBtn accepts custom label', () => {
  const b = backBtn('s.r', { label: '⬅' })
  assert.strictEqual(b.text, '⬅')
})

test('closeBtn produces a close button (router knows to delete)', () => {
  const b = closeBtn()
  assert.strictEqual(b.text, '✕ Закрити')
  assert.strictEqual(b.callback_data, 'm:v1:_close')
})

test('toggleBtn shows green dot when on, red when off', () => {
  const on = toggleBtn({ label: 'Антиспам', on: true, callback: 'm:v1:s:t:off' })
  const off = toggleBtn({ label: 'Антиспам', on: false, callback: 'm:v1:s:t:on' })
  assert.ok(on.text.startsWith('🟢'))
  assert.ok(off.text.startsWith('🔴'))
})

test('paginated produces ‹ N/M › nav row when multiple pages', () => {
  const items = Array.from({ length: 25 }, (_, i) => `item${i}`)
  const result = paginated({ items, page: 1, perPage: 10, screenId: 'list' })
  assert.strictEqual(result.pageItems.length, 10)
  assert.deepStrictEqual(result.pageItems, items.slice(10, 20))
  assert.strictEqual(result.nav.length, 3)
  assert.strictEqual(result.nav[0].text, '‹')
  assert.strictEqual(result.nav[1].text, '2 / 3')
  assert.strictEqual(result.nav[2].text, '›')
  assert.strictEqual(result.nav[0].callback_data, 'm:v1:list:page:0')
  assert.strictEqual(result.nav[2].callback_data, 'm:v1:list:page:2')
})

test('paginated returns empty nav when only one page', () => {
  const items = ['a', 'b']
  const result = paginated({ items, page: 0, perPage: 10, screenId: 'list' })
  assert.strictEqual(result.nav.length, 0)
  assert.strictEqual(result.pageItems.length, 2)
})

test('paginated clamps page to valid range', () => {
  const items = Array.from({ length: 25 }, (_, i) => i)
  const high = paginated({ items, page: 99, perPage: 10, screenId: 'list' })
  assert.strictEqual(high.page, 2)
  const low = paginated({ items, page: -5, perPage: 10, screenId: 'list' })
  assert.strictEqual(low.page, 0)
})

test('paginated nav at first page disables ‹ (callback_data === noop)', () => {
  const items = Array.from({ length: 25 }, (_, i) => i)
  const result = paginated({ items, page: 0, perPage: 10, screenId: 'list' })
  assert.strictEqual(result.nav[0].callback_data, 'm:v1:_noop')
})

test('paginated nav at last page disables ›', () => {
  const items = Array.from({ length: 25 }, (_, i) => i)
  const result = paginated({ items, page: 2, perPage: 10, screenId: 'list' })
  assert.strictEqual(result.nav[2].callback_data, 'm:v1:_noop')
})

test('cb works with dotted screenId', () => {
  assert.strictEqual(cb('settings.antispam', 'toggle'), 'm:v1:settings.antispam:toggle')
})

test('confirmKeyboard returns Yes / No row', () => {
  const kb = confirmKeyboard({
    yesLabel: 'Так', yesCallback: 'm:v1:s:do',
    noLabel: 'Ні', noCallback: 'm:v1:s:cancel'
  })
  assert.strictEqual(kb.inline_keyboard.length, 1)
  assert.strictEqual(kb.inline_keyboard[0].length, 2)
  assert.strictEqual(kb.inline_keyboard[0][0].text, 'Так')
  assert.strictEqual(kb.inline_keyboard[0][1].text, 'Ні')
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) }
    catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
