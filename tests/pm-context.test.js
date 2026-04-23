// PM-context tracking: maps userId → target chat for menu callbacks in DM.

const assert = require('assert')
const pm = require('../helpers/menu/pm-context')
const { liftPmTarget } = require('../routes/menu')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('set/get/clear roundtrip', () => {
  pm.clearAll()
  pm.setPmTarget(42, -100500)
  assert.strictEqual(pm.getPmTarget(42), -100500)
  pm.clearPmTarget(42)
  assert.strictEqual(pm.getPmTarget(42), null)
})

test('returns null for unknown user', () => {
  pm.clearAll()
  assert.strictEqual(pm.getPmTarget(999), null)
})

test('liftPmTarget no-op in group chat', async () => {
  pm.clearAll()
  pm.setPmTarget(7, -100)
  const ctx = { chat: { id: -100, type: 'supergroup' }, from: { id: 7 } }
  await liftPmTarget(ctx)
  assert.strictEqual(ctx.targetChatId, undefined, 'must not lift in group')
})

test('liftPmTarget no-op when no PM target stored', async () => {
  pm.clearAll()
  const ctx = { chat: { id: 555, type: 'private' }, from: { id: 7 } }
  await liftPmTarget(ctx)
  assert.strictEqual(ctx.targetChatId, undefined)
})

test('liftPmTarget injects targetChatId in PM', async () => {
  pm.clearAll()
  pm.setPmTarget(7, -100500)
  const ctx = {
    chat: { id: 555, type: 'private' },
    from: { id: 7 },
    db: null
  }
  await liftPmTarget(ctx)
  assert.strictEqual(ctx.targetChatId, -100500)
})

test('liftPmTarget loads Group when db is available', async () => {
  pm.clearAll()
  pm.setPmTarget(7, -100500)
  const groupDoc = { group_id: -100500, settings: { foo: 'bar' } }
  const ctx = {
    chat: { id: 555, type: 'private' },
    from: { id: 7 },
    db: { Group: { findOne: async () => groupDoc } }
  }
  await liftPmTarget(ctx)
  assert.strictEqual(ctx.targetChatId, -100500)
  assert.strictEqual(ctx.group.info.settings.foo, 'bar')
})

test('liftPmTarget swallows db errors silently', async () => {
  pm.clearAll()
  pm.setPmTarget(7, -100500)
  const ctx = {
    chat: { id: 555, type: 'private' },
    from: { id: 7 },
    db: { Group: { findOne: async () => { throw new Error('db down') } } }
  }
  await liftPmTarget(ctx)
  assert.strictEqual(ctx.targetChatId, -100500, 'targetChatId still set')
  assert.strictEqual(ctx.group, undefined, 'group not injected on error')
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
