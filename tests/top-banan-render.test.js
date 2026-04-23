const assert = require('assert')

delete require.cache[require.resolve('../helpers/menu/registry')]
const topBanan = require('../helpers/menu/screens/stats-top-banan')
const { humanizeBan } = topBanan

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('humanizeBan: 0 seconds returns some English "0 …"', () => {
  const s = humanizeBan(0, 'en')
  assert.ok(s && s.length > 0)
})

test('humanizeBan: 3600 seconds renders as "1 hour" (en)', () => {
  const s = humanizeBan(3600, 'en')
  assert.ok(/hour/i.test(s), `got "${s}"`)
})

test('humanizeBan handles falsy seconds without throwing', () => {
  assert.doesNotThrow(() => humanizeBan(null, 'en'))
  assert.doesNotThrow(() => humanizeBan(undefined, 'en'))
})

// Confirm the module re-exports the top helpers so pagination stays in sync.
test('exports shared pagination constants', () => {
  assert.strictEqual(typeof topBanan.PER_PAGE, 'number')
  assert.strictEqual(topBanan.PER_PAGE, 10)
  assert.ok(Array.isArray(topBanan.MEDALS))
  assert.strictEqual(topBanan.MEDALS.length, 3)
})

test('SCREEN_ID is the documented stats.top_banan', () => {
  assert.strictEqual(topBanan.SCREEN_ID, 'stats.top_banan')
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
