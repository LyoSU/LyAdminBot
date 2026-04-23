const assert = require('assert')

// Import pure helpers (don't trigger screen registration side-effects).
delete require.cache[require.resolve('../helpers/menu/registry')]
const topScreen = require('../helpers/menu/screens/stats-top')
const { padRank, renderPage, buildKeyboard, MEDALS, PER_PAGE, NBSP } = topScreen

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const stubI18n = () => ({
  locale: () => 'en',
  t: (key, params = {}) => {
    if (key === 'menu.stats.top.title') {
      return `TITLE ${params.chatName} p=${params.page}/${params.total}`
    }
    if (key === 'menu.stats.top.item') {
      return `${params.rank}${params.medal}${params.name}  ${params.value}`
    }
    return key
  }
})

const mkRows = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1,
  name: `u${i + 1}`,
  value: `${(100 - i).toFixed(2)}%`
}))

test('padRank adds NBSP for single-digit numbers', () => {
  assert.strictEqual(padRank(1), NBSP + '1')
  assert.strictEqual(padRank(9), NBSP + '9')
})

test('padRank leaves 2+ digit numbers alone', () => {
  assert.strictEqual(padRank(10), '10')
  assert.strictEqual(padRank(100), '100')
})

test('medals only appear on page 1', () => {
  const rows = mkRows(25)
  const page1 = renderPage({ rows, page: 0, chatName: 'C', i18n: stubI18n() })
  const page2 = renderPage({ rows, page: 1, chatName: 'C', i18n: stubI18n() })
  // Page 1: first 3 items carry medal emojis
  for (const m of MEDALS) {
    assert.ok(page1.text.includes(m), `page 1 should contain ${m}`)
  }
  // Page 2: no medal glyphs
  for (const m of MEDALS) {
    assert.ok(!page2.text.includes(m), `page 2 should NOT contain ${m}`)
  }
})

test('pagination math: 10 rows → 1 page', () => {
  const { totalPages, pageItems } = renderPage({
    rows: mkRows(10),
    page: 0,
    chatName: 'C',
    i18n: stubI18n()
  })
  assert.strictEqual(totalPages, 1)
  assert.strictEqual(pageItems.length, 10)
})

test('pagination math: 11 rows → 2 pages', () => {
  const p1 = renderPage({ rows: mkRows(11), page: 0, chatName: 'C', i18n: stubI18n() })
  const p2 = renderPage({ rows: mkRows(11), page: 1, chatName: 'C', i18n: stubI18n() })
  assert.strictEqual(p1.totalPages, 2)
  assert.strictEqual(p1.pageItems.length, 10)
  assert.strictEqual(p2.pageItems.length, 1)
})

test('page overflow clamps to last page', () => {
  const out = renderPage({ rows: mkRows(5), page: 99, chatName: 'C', i18n: stubI18n() })
  assert.strictEqual(out.page, 0) // only 1 page, so clamps to 0
})

test('NBSP alignment: rank "1." uses padded form on page 1', () => {
  const out = renderPage({ rows: mkRows(1), page: 0, chatName: 'C', i18n: stubI18n() })
  // rank token in stub template is verbatim ${rank}
  assert.ok(out.text.includes(NBSP + '1.'))
})

test('buildKeyboard: pagination row appears when totalPages > 1', () => {
  const kb = buildKeyboard({ page: 0, totalPages: 3, screenId: 'stats.top' })
  // nav row + close row
  assert.strictEqual(kb.inline_keyboard.length, 2)
  assert.strictEqual(kb.inline_keyboard[0].length, 3) // ‹ counter ›
})

test('buildKeyboard: no pagination row when only 1 page', () => {
  const kb = buildKeyboard({ page: 0, totalPages: 1, screenId: 'stats.top' })
  // only close row
  assert.strictEqual(kb.inline_keyboard.length, 1)
})

test('PER_PAGE is 10 (spec requirement)', () => {
  assert.strictEqual(PER_PAGE, 10)
})

;(async () => {
  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      console.log('✓', t.name)
    } catch (err) {
      failed++
      console.error('✗', t.name, '—', err.message)
    }
  }
  if (failed) process.exit(1)
})()
