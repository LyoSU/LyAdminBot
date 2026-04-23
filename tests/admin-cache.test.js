// Admin-status cache: serves repeated menu callbacks in PM (settings flow)
// without round-tripping Telegram for every click.

const assert = require('assert')
const adminCache = require('../helpers/admin-cache')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkTg = (status, calls = { n: 0 }) => ({
  getChatMember: async () => { calls.n++; return { status } }
})

test('returns true for administrator', async () => {
  adminCache.clearAll()
  const tg = mkTg('administrator')
  assert.strictEqual(await adminCache.isUserAdmin(tg, -100, 1), true)
})

test('returns true for creator', async () => {
  adminCache.clearAll()
  const tg = mkTg('creator')
  assert.strictEqual(await adminCache.isUserAdmin(tg, -100, 1), true)
})

test('returns false for member', async () => {
  adminCache.clearAll()
  const tg = mkTg('member')
  assert.strictEqual(await adminCache.isUserAdmin(tg, -100, 1), false)
})

test('caches result — second call does not hit telegram', async () => {
  adminCache.clearAll()
  const calls = { n: 0 }
  const tg = mkTg('administrator', calls)
  await adminCache.isUserAdmin(tg, -100, 1)
  await adminCache.isUserAdmin(tg, -100, 1)
  await adminCache.isUserAdmin(tg, -100, 1)
  assert.strictEqual(calls.n, 1, 'getChatMember called only once')
})

test('cache is per chat+user pair', async () => {
  adminCache.clearAll()
  const calls = { n: 0 }
  const tg = mkTg('administrator', calls)
  await adminCache.isUserAdmin(tg, -100, 1)
  await adminCache.isUserAdmin(tg, -100, 2)
  await adminCache.isUserAdmin(tg, -200, 1)
  assert.strictEqual(calls.n, 3)
})

test('falsy on getChatMember throw', async () => {
  adminCache.clearAll()
  const tg = { getChatMember: async () => { throw new Error('down') } }
  assert.strictEqual(await adminCache.isUserAdmin(tg, -100, 1), false)
})

test('setKnownAdmin pre-seeds cache (deep-link path)', async () => {
  adminCache.clearAll()
  const calls = { n: 0 }
  const tg = mkTg('member', calls)  // would deny if hit
  adminCache.setKnownAdmin(-100, 1, true)
  assert.strictEqual(await adminCache.isUserAdmin(tg, -100, 1), true)
  assert.strictEqual(calls.n, 0, 'cache hit, telegram skipped')
})

test('invalidate clears single entry', async () => {
  adminCache.clearAll()
  const tg = mkTg('administrator')
  await adminCache.isUserAdmin(tg, -100, 1)
  adminCache.invalidate(-100, 1)
  const tg2 = mkTg('member')
  assert.strictEqual(await adminCache.isUserAdmin(tg2, -100, 1), false)
})

const run = async () => {
  let p = 0; let f = 0
  for (const t of tests) {
    try { await t.fn(); p++; console.log('  ✓ ' + t.name) } catch (e) { f++; console.log('  ✗ ' + t.name + '\n     ' + e.message) }
  }
  console.log(`\n${p} passed, ${f} failed`)
  process.exit(f === 0 ? 0 : 1)
}
run()
