// Unit tests for helpers/mod-log.js — exercises write/query without Mongo.

const assert = require('assert')
const { logModEvent, queryRecent, countRecent, rangeSince, normalizeActor } =
  require('../helpers/mod-log')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// --- normalizeActor --------------------------------------------------------

test('normalizeActor: null → both null', () => {
  assert.deepStrictEqual(normalizeActor(null), { id: null, name: null })
  assert.deepStrictEqual(normalizeActor(undefined), { id: null, name: null })
})

test('normalizeActor: telegram-shaped { id, first_name }', () => {
  assert.deepStrictEqual(
    normalizeActor({ id: 42, first_name: 'Alice' }),
    { id: 42, name: 'Alice' }
  )
})

test('normalizeActor: prefers explicit name over first_name', () => {
  assert.deepStrictEqual(
    normalizeActor({ id: 1, name: 'Override', first_name: 'Bob' }),
    { id: 1, name: 'Override' }
  )
})

test('normalizeActor: falls back to username then title', () => {
  assert.deepStrictEqual(
    normalizeActor({ id: 1, username: 'u' }),
    { id: 1, name: 'u' }
  )
  assert.deepStrictEqual(
    normalizeActor({ id: 1, title: 'CH' }),
    { id: 1, name: 'CH' }
  )
})

test('normalizeActor: telegram_id alias works', () => {
  assert.deepStrictEqual(
    normalizeActor({ telegram_id: 7, first_name: 'X' }),
    { id: 7, name: 'X' }
  )
})

// --- logModEvent -----------------------------------------------------------

const mkDb = () => {
  const created = []
  return {
    created,
    ModLog: {
      async create (doc) { created.push(doc); return doc },
      async find () { return { sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) } },
      async countDocuments () { return 0 }
    }
  }
}

test('logModEvent: writes a row with normalized actor/target', async () => {
  const db = mkDb()
  const row = await logModEvent(db, {
    chatId: -100,
    eventType: 'manual_ban',
    actor: { id: 1, first_name: 'Admin' },
    target: { id: 2, first_name: 'Spammer' },
    action: '5m',
    reason: 'forward_blacklist'
  })
  assert.ok(row, 'returned a row')
  assert.strictEqual(db.created.length, 1)
  assert.deepStrictEqual(db.created[0], {
    chatId: -100,
    eventType: 'manual_ban',
    actorId: 1,
    actorName: 'Admin',
    targetId: 2,
    targetName: 'Spammer',
    action: '5m',
    reason: 'forward_blacklist'
  })
})

test('logModEvent: returns null on missing db / chatId / eventType', async () => {
  assert.strictEqual(await logModEvent(null, { chatId: 1, eventType: 'trust' }), null)
  assert.strictEqual(await logModEvent(mkDb(), { eventType: 'trust' }), null)
  assert.strictEqual(await logModEvent(mkDb(), { chatId: 1 }), null)
})

test('logModEvent: swallows DB errors', async () => {
  const db = {
    ModLog: { create: async () => { throw new Error('db fail') } }
  }
  const result = await logModEvent(db, {
    chatId: -100,
    eventType: 'auto_ban'
  })
  assert.strictEqual(result, null)
})

test('logModEvent: trims action and reason length', async () => {
  const db = mkDb()
  const longAction = 'x'.repeat(200)
  const longReason = 'y'.repeat(500)
  await logModEvent(db, {
    chatId: -100,
    eventType: 'settings_change',
    action: longAction,
    reason: longReason
  })
  assert.strictEqual(db.created[0].action.length, 100)
  assert.strictEqual(db.created[0].reason.length, 200)
})

test('logModEvent: actor / target may be null (bot/system)', async () => {
  const db = mkDb()
  await logModEvent(db, {
    chatId: -100,
    eventType: 'auto_ban',
    target: { id: 9 }
  })
  assert.strictEqual(db.created[0].actorId, null)
  assert.strictEqual(db.created[0].actorName, null)
})

// --- queryRecent / countRecent ---------------------------------------------

test('queryRecent: returns [] on missing db / chatId', async () => {
  assert.deepStrictEqual(await queryRecent(null, -100), [])
  assert.deepStrictEqual(await queryRecent({}, null), [])
})

test('queryRecent: builds query with since + cursor + limit', async () => {
  let lastQuery = null
  let lastSort = null
  let lastLimit = null
  const db = {
    ModLog: {
      find (q) {
        lastQuery = q
        return {
          sort (s) { lastSort = s; return this },
          limit (n) { lastLimit = n; return this },
          lean: async () => [{ a: 1 }]
        }
      }
    }
  }
  const since = new Date('2026-01-01T00:00:00Z')
  const cursor = new Date('2026-02-01T00:00:00Z')
  const out = await queryRecent(db, -100, { since, cursor, limit: 5 })
  assert.deepStrictEqual(out, [{ a: 1 }])
  assert.strictEqual(lastQuery.chatId, -100)
  assert.deepStrictEqual(lastQuery.timestamp, { $gte: since, $lt: cursor })
  assert.deepStrictEqual(lastSort, { timestamp: -1 })
  assert.strictEqual(lastLimit, 5)
})

test('queryRecent: clamps limit into [1..100]', async () => {
  let lastLimit = null
  const db = {
    ModLog: {
      find () {
        return { sort () { return this }, limit (n) { lastLimit = n; return this }, lean: async () => [] }
      }
    }
  }
  await queryRecent(db, -100, { limit: 999 })
  assert.strictEqual(lastLimit, 100)
  await queryRecent(db, -100, { limit: -3 })
  assert.strictEqual(lastLimit, 1)
})

test('countRecent: returns count, 0 on error', async () => {
  const db = { ModLog: { countDocuments: async () => 7 } }
  assert.strictEqual(await countRecent(db, -100), 7)
  const dbErr = { ModLog: { countDocuments: async () => { throw new Error('x') } } }
  assert.strictEqual(await countRecent(dbErr, -100), 0)
})

// --- rangeSince ------------------------------------------------------------

test('rangeSince: 24h returns ~24h ago Date', () => {
  const before = Date.now() - 24 * 60 * 60 * 1000
  const d = rangeSince('24h')
  assert.ok(d instanceof Date)
  assert.ok(Math.abs(d.getTime() - before) < 5000)
})

test('rangeSince: 7d returns ~7d ago Date', () => {
  const before = Date.now() - 7 * 24 * 60 * 60 * 1000
  const d = rangeSince('7d')
  assert.ok(Math.abs(d.getTime() - before) < 5000)
})

test('rangeSince: all returns null', () => {
  assert.strictEqual(rangeSince('all'), null)
})

test('rangeSince: unknown returns null', () => {
  assert.strictEqual(rangeSince('weird'), null)
})

// --- run -------------------------------------------------------------------

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + (e.stack || e.message)) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
