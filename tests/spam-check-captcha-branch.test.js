const assert = require('assert')
const path = require('path')

// Swap out the heavy dependencies of middlewares/spam-check before requiring
// it. We use the Node require cache — set the module exports to our stubs
// keyed by their ABSOLUTE resolved paths, matching what spam-check requests.
const preload = (relPath, exports) => {
  const abs = require.resolve(relPath)
  require.cache[abs] = {
    id: abs,
    filename: abs,
    loaded: true,
    exports,
    children: [],
    paths: []
  }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// Captured between test invocations.
let lastCaptchaCall = null
let spamResult = null

preload('../helpers/spam-check', {
  checkSpam: async () => spamResult,
  checkTrustedUser: () => false,
  getSpamSettings: () => ({ enabled: true, confidenceThreshold: 70 })
})
preload('../helpers/captcha-flow', {
  startMidConfidenceCaptcha: async (ctx, opts) => {
    lastCaptchaCall = { ctx, opts }
    return { ok: true }
  }
})
preload('../helpers/reputation', { processSpamAction: () => ({ statsUpdated: false }) })
preload('../helpers/vote-ui', {
  createVoteEvent: async () => null,
  getAccountAgeDays: () => 100
})
preload('../helpers/spam-signatures', { addSignature: async () => null })
preload('../helpers/velocity', { getForwardHash: () => null })
// Realistic buildUserSignals mock — returns the same shape helpers/spam-signals
// actually produces. A previous empty-object stub would have silently passed
// even if middleware started reading fields that were never mocked (the same
// silent-drift class that hid the `userContext.user.*` bug for months).
const makeUserSignals = (overrides = {}) => ({
  userId: 42,
  isPremium: false,
  hasUsername: false,
  totalMessages: 1,
  groupsActive: 1,
  spamDetections: 0,
  cleanMessages: 0,
  uniquenessRatio: 1,
  trackedMessages: 1,
  nameHistoryLen: 1,
  usernameHistoryLen: 0,
  nameChurn24h: 0,
  usernameChurn24h: 0,
  reputation: { score: 50, status: 'neutral' },
  lols: null,
  cas: null,
  accountAge: null,
  replyRatio: null,
  avgMessageLength: 0,
  lengthStdDev: 0,
  hourZeroCount: 0,
  topLanguage: null,
  uiLanguage: null,
  hiddenUrlRatio: null,
  ...overrides
})
preload('../helpers/spam-signals', {
  logSpamDecision: () => {},
  buildUserSignals: () => makeUserSignals()
})
preload('../helpers/edit-diff', {
  snapshotMessage: () => {},
  analyzeEdit: () => null
})
preload('../helpers/admin-feedback', { recordAction: () => {} })
preload('../helpers/mod-event-send', { sendModEventNotification: async () => null })
preload('../helpers/bot-permissions', {
  resolve: async () => ({ canAct: true, canRestrict: true, canDelete: true }),
  get: () => ({ canAct: true, canRestrict: true, canDelete: true }),
  _resetForTests: () => {}
})
preload('../helpers/typing', { withTyping: async (_ctx, fn) => fn() })

const spamCheck = require(path.resolve(__dirname, '..', 'middlewares', 'spam-check'))

const mkCtx = () => ({
  from: { id: 42, first_name: 'Suspect' },
  chat: { id: -100500, type: 'supergroup', title: 'Test group' },
  message: { message_id: 777, text: 'check this offer' },
  update: { message: { message_id: 777, text: 'check this offer' } },
  botInfo: { id: 7, username: 'TestBot' },
  session: {},
  group: {
    info: { settings: {} },
    members: {
      42: { stats: { messagesCount: 1 } }
    }
  },
  i18n: { t: (k) => k },
  telegram: {
    callApi: async () => ({}),
    getChatMember: async () => ({ status: 'member' }),
    getChatAdministrators: async () => [],
    restrictChatMember: async () => ({}),
    deleteMessage: async () => ({})
  }
})

test('mid-confidence verdict routes to captcha flow', async () => {
  spamResult = {
    isSpam: true,
    confidence: 65,
    reason: 'weak_llm',
    source: 'llm'
  }
  lastCaptchaCall = null
  const ctx = mkCtx()
  const ret = await spamCheck(ctx)
  assert.strictEqual(ret, true, 'middleware signals handled')
  assert.ok(lastCaptchaCall, 'startMidConfidenceCaptcha invoked')
  assert.strictEqual(lastCaptchaCall.opts.confidence, 65)
})

test('below captcha floor (<60) falls through without captcha', async () => {
  spamResult = {
    isSpam: true,
    confidence: 55,
    reason: 'tiny',
    source: 'llm'
  }
  lastCaptchaCall = null
  const ctx = mkCtx()
  const ret = await spamCheck(ctx)
  assert.ok(!lastCaptchaCall, 'captcha flow MUST NOT fire below the floor')
  assert.notStrictEqual(ret, true, 'middleware should let this pass')
})

test('above threshold falls to the mute branch, not captcha', async () => {
  spamResult = {
    isSpam: true,
    confidence: 85,
    reason: 'obvious',
    source: 'llm'
  }
  lastCaptchaCall = null
  const ctx = mkCtx()
  await spamCheck(ctx)
  assert.ok(!lastCaptchaCall, 'captcha MUST NOT fire when standard action would')
})

test('recently-passed user skips captcha branch', async () => {
  spamResult = {
    isSpam: true,
    confidence: 65,
    reason: 'weak_llm',
    source: 'llm'
  }
  lastCaptchaCall = null
  const ctx = mkCtx()
  ctx.session.userInfo = { captchaPassedAt: new Date() }
  await spamCheck(ctx)
  assert.ok(!lastCaptchaCall, 'whitelisted user bypasses captcha branch')
})

test('non-spam verdict never triggers captcha', async () => {
  // Guard against a confidence-only check: even at a number that would route
  // to captcha under the mid-confidence band, if isSpam is false we must
  // never fire the flow.
  spamResult = { isSpam: false, confidence: 65, reason: 'clean', source: 'llm' }
  lastCaptchaCall = null
  const ctx = mkCtx()
  const ret = await spamCheck(ctx)
  assert.ok(!lastCaptchaCall, 'captcha must not fire for clean verdicts')
  assert.notStrictEqual(ret, true, 'clean messages should pass through')
})

test('admin caller is exempt from captcha routing', async () => {
  // Admins can write anything — verdict path shouldn't even evaluate.
  spamResult = { isSpam: true, confidence: 65, reason: 'weak_llm', source: 'llm' }
  lastCaptchaCall = null
  const ctx = mkCtx()
  ctx.telegram.getChatAdministrators = async () => [{ user: { id: 42 } }]
  // Use a fresh chat id so the cached empty admin list from earlier tests
  // doesn't bleed in — the middleware keeps a process-local admin cache.
  ctx.chat.id = -100777
  await spamCheck(ctx)
  assert.ok(!lastCaptchaCall, 'admin caller must bypass captcha (and all action branches)')
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
