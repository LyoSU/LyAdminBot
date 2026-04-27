const assert = require('assert')
const { createI18n } = require('../bot/i18n')

const { sendModEventNotification } = require('../helpers/mod-event-send')

const i18nLoader = createI18n()

const mkI18n = (lang = 'uk') => i18nLoader.createContext(lang)

// Stub ctx / db / telegram so sendModEventNotification runs without Mongo.
// We capture the calls on arrays to assert on them.
const mkCtx = () => {
  const calls = { sendMessage: [], ScheduledDeletionSchedule: [] }
  const created = []
  const ModEvent = {
    create: async (fields) => {
      const row = Object.assign({ eventId: `ev${created.length}`, toObject: () => row }, fields)
      created.push(row)
      return row
    },
    findOneAndUpdate: async (query, patch) => {
      const hit = created.find(r => r.eventId === query.eventId)
      if (!hit) return null
      Object.assign(hit, patch.$set || {})
      return hit
    },
    findOne: async (query) => created.find(r => r.eventId === query.eventId) || null
  }
  const ScheduledDeletion = {
    schedule: async (opts) => {
      calls.ScheduledDeletionSchedule.push(opts)
      return { ...opts, deleteAt: new Date(Date.now() + opts.delayMs) }
    },
    deleteOne: async () => ({ deletedCount: 1 })
  }
  const telegram = {
    callApi: async (method, payload) => {
      calls.sendMessage.push({ method, payload })
      if (method === 'sendMessage') return { message_id: 9001 }
      return null
    },
    deleteMessage: async () => true
  }
  return {
    ctx: {
      telegram,
      chat: { id: -100500, type: 'supergroup' },
      db: { ModEvent, ScheduledDeletion },
      i18n: mkI18n('uk')
    },
    created,
    calls
  }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('creates event row + sends message + schedules deletion + patches row', async () => {
  const { ctx, created, calls } = mkCtx()
  const result = await sendModEventNotification(ctx, {
    actionType: 'auto_ban',
    targetUser: { id: 42, first_name: 'Alice', username: 'alice' },
    confidence: 92,
    reason: 'phishing',
    messagePreview: 'buy crypto now'
  })

  assert.ok(result, 'returns result')
  assert.ok(result.event, 'returns event')
  assert.strictEqual(result.sentMessageId, 9001)
  assert.strictEqual(created.length, 1)
  assert.strictEqual(created[0].chatId, -100500)
  assert.strictEqual(created[0].targetId, 42)
  assert.strictEqual(created[0].actionType, 'auto_ban')
  assert.strictEqual(created[0].confidence, 92)
  assert.strictEqual(created[0].reason, 'phishing')
  assert.strictEqual(created[0].notificationMessageId, 9001)
  assert.strictEqual(created[0].notificationChatId, -100500)

  assert.strictEqual(calls.sendMessage.length, 1)
  const sent = calls.sendMessage[0]
  assert.strictEqual(sent.method, 'sendMessage')
  assert.ok(sent.payload.text.includes('⛔'))
  assert.ok(sent.payload.text.includes('@alice'))
  assert.strictEqual(sent.payload.parse_mode, 'HTML')
  assert.ok(sent.payload.reply_markup && sent.payload.reply_markup.inline_keyboard)

  assert.strictEqual(calls.ScheduledDeletionSchedule.length, 1)
  const sched = calls.ScheduledDeletionSchedule[0]
  assert.strictEqual(sched.messageId, 9001)
  assert.strictEqual(sched.delayMs, 90000, '90s for compact default')
  assert.strictEqual(sched.source, 'mod_event:auto_ban')
})

test('override uses 30s TTL', async () => {
  const { ctx, calls } = mkCtx()
  await sendModEventNotification(ctx, {
    actionType: 'override',
    targetUser: { id: 42, first_name: 'Alice' },
    actor: { id: 7, first_name: 'AdminBob' }
  })
  assert.strictEqual(calls.ScheduledDeletionSchedule[0].delayMs, 30000)
})

test('messagePreview truncated to 200 chars at DB-row level', async () => {
  const { ctx, created } = mkCtx()
  const long = 'x'.repeat(500)
  await sendModEventNotification(ctx, {
    actionType: 'auto_ban',
    targetUser: { id: 1, first_name: 'L' },
    messagePreview: long
  })
  assert.strictEqual(created[0].messagePreview.length, 200)
})

test('returns null + swallows when db.ModEvent missing', async () => {
  const { ctx } = mkCtx()
  ctx.db = {}
  const r = await sendModEventNotification(ctx, {
    actionType: 'auto_ban',
    targetUser: { id: 1 }
  })
  assert.strictEqual(r, null)
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + (e.stack || e.message)) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
