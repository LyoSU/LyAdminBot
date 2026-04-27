// Unit tests for helpers/timers.js — pinning the contract for our
// background-job hygiene utilities.

const assert = require('assert')
const { unrefSafe, safeInterval, safeTimeout } = require('../helpers/timers')

let passed = 0
let failed = 0

const test = (name, fn) => {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name} — ${err.message}`)
    failed++
  }
}

const testAsync = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name} — ${err.message}`)
    failed++
  }
}

// unrefSafe -----------------------------------------------------------

test('unrefSafe returns the timer unchanged', () => {
  const fakeTimer = { unref: () => {} }
  assert.strictEqual(unrefSafe(fakeTimer), fakeTimer)
})

test('unrefSafe calls .unref() when present', () => {
  let called = 0
  const fakeTimer = { unref: () => { called++ } }
  unrefSafe(fakeTimer)
  assert.strictEqual(called, 1)
})

test('unrefSafe handles missing .unref gracefully', () => {
  const fakeTimer = {} // no .unref method (e.g. some test shims)
  assert.doesNotThrow(() => unrefSafe(fakeTimer))
})

test('unrefSafe handles null/undefined', () => {
  assert.doesNotThrow(() => unrefSafe(null))
  assert.doesNotThrow(() => unrefSafe(undefined))
})

// safeInterval --------------------------------------------------------

;(async () => {
  await testAsync('safeInterval invokes callback on each tick', async () => {
    let ticks = 0
    const id = safeInterval(() => { ticks++ }, 20)
    await new Promise(resolve => setTimeout(resolve, 75))
    clearInterval(id)
    assert.ok(ticks >= 2, `expected >= 2 ticks, got ${ticks}`)
  })

  await testAsync('safeInterval logs and swallows synchronous throw', async () => {
    const errs = []
    const log = { error: (obj, msg) => errs.push({ obj, msg }) }
    const id = safeInterval(() => { throw new Error('sync boom') }, 20, { log, label: 'test-sync' })
    await new Promise(resolve => setTimeout(resolve, 60))
    clearInterval(id)
    assert.ok(errs.length >= 1, 'expected at least one logged error')
    assert.strictEqual(errs[0].obj.label, 'test-sync')
    assert.strictEqual(errs[0].obj.err.message, 'sync boom')
  })

  await testAsync('safeInterval logs and swallows async rejection', async () => {
    const errs = []
    const log = { error: (obj, msg) => errs.push({ obj, msg }) }
    const id = safeInterval(async () => { throw new Error('async boom') }, 20, { log, label: 'test-async' })
    await new Promise(resolve => setTimeout(resolve, 60))
    clearInterval(id)
    assert.ok(errs.length >= 1, 'expected at least one logged error')
    assert.strictEqual(errs[0].obj.err.message, 'async boom')
  })

  await testAsync('safeInterval returns a timer that can be cleared', async () => {
    let ticks = 0
    const id = safeInterval(() => { ticks++ }, 20)
    clearInterval(id)
    const before = ticks
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.strictEqual(ticks, before, 'cleared interval should not tick further')
  })

  await testAsync('safeInterval continues ticking after a single rejection', async () => {
    let ticks = 0
    const errs = []
    const log = { error: (obj) => errs.push(obj) }
    const id = safeInterval(async () => {
      ticks++
      if (ticks === 1) throw new Error('first tick fails')
    }, 20, { log })
    await new Promise(resolve => setTimeout(resolve, 100))
    clearInterval(id)
    assert.ok(ticks >= 3, `expected >= 3 ticks (failure shouldn't stop loop), got ${ticks}`)
    assert.strictEqual(errs.length, 1, 'only the first tick should have logged an error')
  })

  // safeTimeout -------------------------------------------------------

  await testAsync('safeTimeout fires once and swallows rejection', async () => {
    const errs = []
    const log = { error: (obj) => errs.push(obj) }
    safeTimeout(async () => { throw new Error('once') }, 20, { log, label: 'one-shot' })
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.strictEqual(errs.length, 1)
    assert.strictEqual(errs[0].err.message, 'once')
  })

  if (failed > 0) {
    console.error(`\n${passed} passed, ${failed} failed`)
    process.exit(1)
  }
  console.log(`\n${passed} passed, 0 failed`)
  process.exit(0)
})().catch(err => {
  console.error('Test crashed:', err)
  process.exit(1)
})
