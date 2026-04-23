const assert = require('assert')
const { toast, keyFor, CANONICAL_KEYS } = require('../helpers/menu/toast')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('keyFor prefixes with menu.common.toast', () => {
  assert.strictEqual(keyFor('saved'), 'menu.common.toast.saved')
  assert.strictEqual(keyFor('session_expired'), 'menu.common.toast.session_expired')
})

test('CANONICAL_KEYS contains all 5 spec keys', () => {
  for (const k of ['saved', 'cancelled', 'only_admins', 'session_expired', 'loading']) {
    assert.ok(CANONICAL_KEYS.has(k), `missing canonical key: ${k}`)
  }
})

test('toast() calls answerCbQuery with looked-up text', async () => {
  const calls = []
  const ctx = {
    i18n: { t: (key) => `LOOK:${key}` },
    answerCbQuery: async (text) => { calls.push(text) }
  }
  await toast(ctx, 'saved')
  assert.deepStrictEqual(calls, ['LOOK:menu.common.toast.saved'])
})

test('toast() forwards params to i18n.t', async () => {
  let receivedParams
  const ctx = {
    i18n: { t: (_key, params) => { receivedParams = params; return 'x' } },
    answerCbQuery: async () => {}
  }
  await toast(ctx, 'loading', { n: 5 })
  assert.deepStrictEqual(receivedParams, { n: 5 })
})

test('toast() no-op when ctx.answerCbQuery is missing', async () => {
  // Must not throw.
  await toast({}, 'saved')
  await toast(null, 'saved')
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
