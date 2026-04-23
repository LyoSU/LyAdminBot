/* eslint-disable camelcase */
const assert = require('assert')

delete require.cache[require.resolve('../helpers/menu/registry')]
const extras = require('../helpers/menu/screens/stats-extras')
const { slugify, buildGrid, COLUMNS, PER_PAGE, SCREEN_ID } = extras

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('slugify: ASCII name preserved', () => {
  assert.strictEqual(slugify('hello'), 'hello')
})

test('slugify: Cyrillic kept, punctuation stripped', () => {
  assert.strictEqual(slugify('правила!'), 'правила')
})

test('slugify: truncates to 32 chars', () => {
  assert.strictEqual(slugify('a'.repeat(100)).length, 32)
})

test('buildGrid: 2-column layout', () => {
  const { inline_keyboard } = buildGrid({
    extras: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    page: 0
  })
  // 4 items → 2 rows of 2; plus the close row.
  assert.strictEqual(inline_keyboard.length, 3)
  assert.strictEqual(inline_keyboard[0].length, 2)
  assert.strictEqual(inline_keyboard[1].length, 2)
})

test('buildGrid: odd count produces a half-row', () => {
  const { inline_keyboard } = buildGrid({
    extras: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    page: 0
  })
  // rows: [a,b], [c], close
  assert.strictEqual(inline_keyboard.length, 3)
  assert.strictEqual(inline_keyboard[1].length, 1)
})

test('buildGrid: pagination row when > 10 items', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ name: `x${i}` }))
  const { inline_keyboard, totalPages } = buildGrid({ extras: items, page: 0 })
  assert.strictEqual(totalPages, 2)
  // The last row before close is the pagination nav (3 buttons).
  const navRow = inline_keyboard[inline_keyboard.length - 2]
  assert.strictEqual(navRow.length, 3)
})

test('buildGrid: 10 items → no pagination nav', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ name: `x${i}` }))
  const { inline_keyboard, totalPages } = buildGrid({ extras: items, page: 0 })
  assert.strictEqual(totalPages, 1)
  // 5 rows of 2 items + close row
  assert.strictEqual(inline_keyboard.length, 6)
})

test('buildGrid: tap callback_data follows screen:tap:<slug> shape', () => {
  const { inline_keyboard } = buildGrid({
    extras: [{ name: 'hello' }],
    page: 0
  })
  const tapBtn = inline_keyboard[0][0]
  assert.ok(tapBtn.callback_data.includes('stats.extras:tap:hello'))
  assert.strictEqual(tapBtn.text, '#hello')
})

test('COLUMNS=2 and PER_PAGE=10 match spec', () => {
  assert.strictEqual(COLUMNS, 2)
  assert.strictEqual(PER_PAGE, 10)
})

test('SCREEN_ID is stats.extras', () => {
  assert.strictEqual(SCREEN_ID, 'stats.extras')
})

// Empty-state rendering via the render() function (happy-path stub).
test('render: empty extras list returns empty-state with CTA', async () => {
  const ctx = {
    i18n: { t: (k) => k, locale: () => 'en' },
    group: { info: { settings: { extras: [], maxExtra: 50 } } }
  }
  const view = await extras.render(ctx, {})
  assert.ok(view.text.includes('menu.empty_state.extras.title'))
  assert.ok(view.keyboard.inline_keyboard.length >= 1)
  // First row carries the create CTA.
  const createBtn = view.keyboard.inline_keyboard[0][0]
  assert.ok(createBtn.callback_data.includes('stats.extras:cta'))
})

test('render: populated extras → grid text (title) + buttons', async () => {
  const ctx = {
    i18n: {
      t: (k, params = {}) => params.count !== undefined
        ? `EXTRAS-TITLE ${params.count}/${params.max}`
        : k,
      locale: () => 'en'
    },
    group: {
      info: {
        settings: {
          extras: [{ name: 'hello' }, { name: 'rules' }],
          maxExtra: 50
        }
      }
    }
  }
  const view = await extras.render(ctx, {})
  assert.ok(view.text.includes('EXTRAS-TITLE 2/50'))
  assert.strictEqual(view.keyboard.inline_keyboard[0].length, 2)
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
