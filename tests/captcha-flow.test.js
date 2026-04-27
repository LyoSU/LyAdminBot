const assert = require('assert')
const captchaFlow = require('../helpers/captcha-flow')
const { createI18n } = require('../bot/i18n')

const i18nLoader = createI18n()

const mkI18n = (lang = 'uk') => i18nLoader.createContext(lang)

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = ({ overrideDb, overrideCallApi } = {}) => {
  const calls = { call: [], restrict: [], deletes: [], deletedMessages: [] }
  const createdRows = []
  const createdEvents = []
  const ctx = {
    from: { id: 42, first_name: 'Suspect' },
    chat: { id: -100500, type: 'supergroup' },
    botInfo: { id: 7, username: 'TestBot' },
    i18n: mkI18n('uk'),
    session: { userInfo: { telegram_id: 42 } },
    telegram: {
      callApi: overrideCallApi || (async (method, payload) => {
        calls.call.push({ method, payload })
        if (method === 'sendMessage') return { message_id: 777 }
        return true
      }),
      restrictChatMember: async (chatId, userId, perms) => {
        calls.restrict.push({ chatId, userId, perms })
        return true
      },
      deleteMessage: async (chatId, messageId) => {
        calls.deletedMessages.push({ chatId, messageId })
        return true
      },
      getChatMember: async () => ({
        status: 'administrator',
        can_restrict_members: true,
        can_delete_messages: true
      })
    },
    db: overrideDb || {
      Captcha: {
        findActive: async () => null,
        findOne: async () => null,
        create: async (doc) => {
          const row = { ...doc, challengeId: 'ch123456789a' }
          createdRows.push(row)
          return row
        },
        findOneAndDelete: async () => createdRows[0] || null,
        consume: async () => createdRows[0] || null
      },
      ModEvent: {
        create: async (e) => {
          const out = { ...e, eventId: 'eeeeee000000' }
          createdEvents.push(out)
          return out
        },
        findOne: async () => createdEvents[0] || null,
        findOneAndUpdate: async (q, u) => {
          Object.assign(createdEvents[0] || {}, u.$set || {})
          return createdEvents[0] || null
        }
      },
      ModLog: { create: async () => ({}) },
      User: {
        updateOne: async () => ({}),
        findOneAndUpdate: async () => ({})
      },
      ScheduledDeletion: {
        findOneAndUpdate: async () => ({}),
        create: async () => ({}),
        deleteOne: async () => ({}),
        schedule: async () => ({})
      }
    },
    _createdRows: createdRows,
    _createdEvents: createdEvents,
    _calls: calls
  }
  return ctx
}

test('startMidConfidenceCaptcha restricts + deletes + creates Captcha + emits notification', async () => {
  const ctx = mkCtx()
  const message = { message_id: 555, text: 'hi promo click here' }
  const result = await captchaFlow.startMidConfidenceCaptcha(ctx, {
    senderInfo: ctx.from,
    message,
    confidence: 65,
    reason: 'llm_hint'
  })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(ctx._calls.deletedMessages.length, 1, 'suspect message deleted')
  assert.strictEqual(ctx._calls.restrict.length, 1, 'restrictChatMember called')
  assert.strictEqual(ctx._createdRows.length, 1, 'Captcha row created')
  assert.strictEqual(ctx._createdRows[0].kind, 'mid_confidence')
  assert.strictEqual(ctx._createdEvents.length, 1)
  assert.strictEqual(ctx._createdEvents[0].actionType, 'pending_captcha')
  const sendMsg = ctx._calls.call.find(c => c.method === 'sendMessage')
  assert.ok(sendMsg, 'should post the pending_captcha compact line')
  assert.ok(/перевір|не бот/i.test(sendMsg.payload.text), 'uk compact line mentions the captcha')
  // Clean up the in-process escalation timer so Node can exit cleanly.
  for (const id of captchaFlow._escalationTimers.keys()) captchaFlow._cancelTimer(id)
})

test('startMidConfidenceCaptcha skips when bot lacks restrict permission', async () => {
  const ctx = mkCtx()
  ctx.telegram.getChatMember = async () => ({
    status: 'administrator',
    can_restrict_members: false,
    can_delete_messages: true
  })
  // Wipe cache between tests so the stub reports fresh.
  require('../helpers/bot-permissions')._resetForTests()
  const result = await captchaFlow.startMidConfidenceCaptcha(ctx, {
    senderInfo: ctx.from,
    message: { message_id: 1 },
    confidence: 62,
    reason: 'weak'
  })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.reason, 'no_restrict_perm')
})

test('applyPass lifts restrictions + sets captchaPassedAt + consumes row', async () => {
  require('../helpers/bot-permissions')._resetForTests()
  const ctx = mkCtx()
  const start = await captchaFlow.startMidConfidenceCaptcha(ctx, {
    senderInfo: ctx.from,
    message: { message_id: 555, text: 'x' },
    confidence: 65,
    reason: 'weak'
  })
  assert.ok(start.ok)
  // Reset call log so we can assert the liftRestrictions call cleanly.
  ctx._calls.restrict.length = 0

  const before = Date.now()
  const res = await captchaFlow.applyPass(
    { telegram: ctx.telegram, db: ctx.db, i18n: ctx.i18n },
    start.captcha,
    { userInfo: ctx.session.userInfo, senderInfo: ctx.from }
  )
  assert.strictEqual(res.ok, true)
  assert.ok(ctx._calls.restrict.length >= 1, 'restrictChatMember called to lift')
  // The lift call uses the `permissions` bag.
  const lift = ctx._calls.restrict.find(c => c.perms && c.perms.permissions)
  assert.ok(lift, 'permissions-bag lift should have been issued')
  assert.ok(ctx.session.userInfo.captchaPassedAt instanceof Date)
  assert.ok(ctx.session.userInfo.captchaPassedAt.getTime() >= before)
  for (const id of captchaFlow._escalationTimers.keys()) captchaFlow._cancelTimer(id)
})

test('applyFail on appeal bumps counter and locks after 3', async () => {
  const ctx = mkCtx()
  ctx.session.userInfo.captchaAppealsUsed = 2
  const row = { challengeId: 'abc', userId: 42, kind: 'global_ban_appeal' }
  const res = await captchaFlow.applyFail(
    { telegram: ctx.telegram, db: ctx.db, i18n: ctx.i18n },
    row,
    { userInfo: ctx.session.userInfo }
  )
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.kind, 'global_ban_appeal')
  assert.strictEqual(res.locked, true)
  assert.strictEqual(ctx.session.userInfo.captchaAppealsUsed, 3)
  assert.ok(ctx.session.userInfo.captchaAppealsLockedUntil instanceof Date)
})

test('applyPass on appeal clears isGlobalBanned', async () => {
  const ctx = mkCtx()
  ctx.session.userInfo.isGlobalBanned = true
  const row = { challengeId: 'abc', userId: 42, kind: 'global_ban_appeal' }
  const res = await captchaFlow.applyPass(
    { telegram: ctx.telegram, db: ctx.db, i18n: ctx.i18n },
    row,
    { userInfo: ctx.session.userInfo }
  )
  assert.strictEqual(res.ok, true)
  assert.strictEqual(ctx.session.userInfo.isGlobalBanned, false)
  assert.strictEqual(ctx.session.userInfo.captchaAppealsUsed, 1)
  assert.ok(ctx.session.userInfo.captchaPassedAt instanceof Date)
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) } catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.stack) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
