const assert = require('assert')
const { renderEmptyState } = require('../helpers/menu/empty-state')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const stubI18n = () => ({
  t: (k) => `T:${k}`
})

test('renderEmptyState: basic title + description', () => {
  const { text, keyboard } = renderEmptyState(stubI18n(), {
    titleKey: 't.rules.title',
    descKey: 't.rules.hint'
  })
  // Title line, empty line, description
  assert.ok(text.includes('T:t.rules.title'))
  assert.ok(text.includes('T:t.rules.hint'))
  assert.ok(text.includes('\n\n'))
  assert.deepStrictEqual(keyboard, { inline_keyboard: [] })
})

test('renderEmptyState: icon prepended to title', () => {
  const { text } = renderEmptyState(stubI18n(), {
    icon: '📜',
    titleKey: 'k',
    descKey: 'd'
  })
  assert.ok(text.startsWith('📜 T:k'))
})

test('renderEmptyState: CTAs rendered on one row', () => {
  const { keyboard } = renderEmptyState(stubI18n(), {
    titleKey: 'k',
    descKey: 'd',
    ctas: [
      { label: 'A', callback: 'm:v1:x:a' },
      { label: 'B', callback: 'm:v1:x:b' }
    ]
  })
  assert.strictEqual(keyboard.inline_keyboard.length, 1)
  assert.strictEqual(keyboard.inline_keyboard[0].length, 2)
  assert.strictEqual(keyboard.inline_keyboard[0][0].text, 'A')
  assert.strictEqual(keyboard.inline_keyboard[0][0].callback_data, 'm:v1:x:a')
})

test('renderEmptyState: backScreenId adds back button row', () => {
  const { keyboard } = renderEmptyState(stubI18n(), {
    titleKey: 'k',
    descKey: 'd',
    backScreenId: 'settings.root'
  })
  // Only back row
  assert.strictEqual(keyboard.inline_keyboard.length, 1)
  const btn = keyboard.inline_keyboard[0][0]
  assert.ok(btn.callback_data.includes('settings.root:open'))
})

test('renderEmptyState: CTA + back produce 2 rows', () => {
  const { keyboard } = renderEmptyState(stubI18n(), {
    titleKey: 'k',
    descKey: 'd',
    ctas: [{ label: 'Go', callback: 'm:v1:x:go' }],
    backScreenId: 'parent'
  })
  assert.strictEqual(keyboard.inline_keyboard.length, 2)
})

test('renderEmptyState: falsy/undefined ctas filtered out', () => {
  const { keyboard } = renderEmptyState(stubI18n(), {
    titleKey: 'k',
    descKey: 'd',
    ctas: [null, undefined, { label: 'Only', callback: 'm:v1:x:only' }]
  })
  assert.strictEqual(keyboard.inline_keyboard[0].length, 1)
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
