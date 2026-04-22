const assert = require('assert')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const freshRouter = () => {
  delete require.cache[require.resolve('../helpers/menu/registry')]
  delete require.cache[require.resolve('../helpers/menu/router')]
  return {
    registry: require('../helpers/menu/registry'),
    router: require('../helpers/menu/router')
  }
}

const mkCb = ({ data, fromId = 1, chatId = -100, getChatMember, replyHTML, editHTML, deleteMessage, answerCbQuery, group }) => {
  const calls = { editHTML: [], replyHTML: [], delete: [], cbAnswer: [] }
  return {
    callbackQuery: { data, message: { message_id: 50 } },
    chat: { id: chatId },
    from: { id: fromId },
    i18n: { t: (k) => k },
    group: group || { info: { settings: {} } },
    telegram: {
      getChatMember: getChatMember || (async () => ({ status: 'member' })),
      callApi: async (method, payload) => {
        if (method === 'editMessageText') calls.editHTML.push(payload)
        if (method === 'sendMessage') calls.replyHTML.push(payload)
        if (method === 'deleteMessage') calls.delete.push(payload)
        if (method === 'answerCallbackQuery') calls.cbAnswer.push(payload)
        return { message_id: 51 }
      }
    },
    deleteMessage: deleteMessage || (async () => { calls.delete.push(true); return true }),
    answerCbQuery: answerCbQuery || (async (...args) => { calls.cbAnswer.push(args); return true }),
    _calls: calls
  }
}

test('parses callback data into screenId, action, args', async () => {
  const { router } = freshRouter()
  const parsed = router.parseCallback('m:v1:settings.antispam:open:foo:bar')
  assert.deepStrictEqual(parsed, {
    ok: true,
    screenId: 'settings.antispam',
    action: 'open',
    args: ['foo', 'bar']
  })
})

test('parses minimal data with action only', async () => {
  const { router } = freshRouter()
  const parsed = router.parseCallback('m:v1:s:open')
  assert.deepStrictEqual(parsed, { ok: true, screenId: 's', action: 'open', args: [] })
})

test('dotted screenId is preserved as a single token (no further split)', async () => {
  const { router } = freshRouter()
  const parsed = router.parseCallback('m:v1:settings.welcome.gif:add')
  assert.strictEqual(parsed.screenId, 'settings.welcome.gif')
  assert.strictEqual(parsed.action, 'add')
})

test('parseCallback rejects non-prefixed data', async () => {
  const { router } = freshRouter()
  const parsed = router.parseCallback('sv:abc:spam')
  assert.strictEqual(parsed.ok, false)
})

test('parseCallback rejects malformed data', async () => {
  const { router } = freshRouter()
  assert.strictEqual(router.parseCallback('m:v1:').ok, false)
  assert.strictEqual(router.parseCallback('m:v1:onlyone').ok, false)
})

test('handleCallback for unknown screen answers cbQuery with menu.unknown', async () => {
  const { router } = freshRouter()
  const ctx = mkCb({ data: 'm:v1:nope:open' })
  await router.handleCallback(ctx)
  assert.deepStrictEqual(ctx._calls.cbAnswer[0][0], 'menu.unknown')
})

test('handleCallback denies when access check fails', async () => {
  const { registry, router } = freshRouter()
  registry.registerMenu({
    id: 's.r',
    access: 'group_admin',
    render: () => ({ text: 'x', keyboard: { inline_keyboard: [] } }),
    handle: async () => 'render'
  })
  const ctx = mkCb({ data: 'm:v1:s.r:open', getChatMember: async () => ({ status: 'member' }) })
  await router.handleCallback(ctx)
  assert.strictEqual(ctx._calls.cbAnswer.length, 1)
  assert.strictEqual(ctx._calls.editHTML.length, 0)
})

test('open action invokes render and edits the message', async () => {
  const { registry, router } = freshRouter()
  registry.registerMenu({
    id: 's.r',
    access: 'public',
    render: () => ({ text: '<b>hello</b>', keyboard: { inline_keyboard: [[{ text: 'x', callback_data: 'm:v1:_noop' }]] } }),
    handle: async () => 'render'
  })
  const ctx = mkCb({ data: 'm:v1:s.r:open' })
  await router.handleCallback(ctx)
  assert.strictEqual(ctx._calls.editHTML.length, 1)
  const e = ctx._calls.editHTML[0]
  assert.strictEqual(e.text, '<b>hello</b>')
  assert.strictEqual(e.message_id, 50)
  assert.deepStrictEqual(e.reply_markup.inline_keyboard[0][0], { text: 'x', callback_data: 'm:v1:_noop' })
})

test('handle returns "render" → router calls render and edits', async () => {
  const { registry, router } = freshRouter()
  let handleCalled = false
  registry.registerMenu({
    id: 's',
    access: 'public',
    render: () => ({ text: 'rendered', keyboard: { inline_keyboard: [] } }),
    handle: async (ctx, action, args) => {
      handleCalled = true
      assert.strictEqual(action, 'toggle')
      assert.deepStrictEqual(args, ['on'])
      return 'render'
    }
  })
  const ctx = mkCb({ data: 'm:v1:s:toggle:on' })
  await router.handleCallback(ctx)
  assert.strictEqual(handleCalled, true)
  assert.strictEqual(ctx._calls.editHTML.length, 1)
  assert.strictEqual(ctx._calls.editHTML[0].text, 'rendered')
})

test('handle returns {toast, render: false} → answerCbQuery only', async () => {
  const { registry, router } = freshRouter()
  registry.registerMenu({
    id: 's',
    access: 'public',
    render: () => ({ text: 'r', keyboard: { inline_keyboard: [] } }),
    handle: async () => ({ toast: 'menu.saved', render: false })
  })
  const ctx = mkCb({ data: 'm:v1:s:save' })
  await router.handleCallback(ctx)
  assert.strictEqual(ctx._calls.editHTML.length, 0)
  assert.strictEqual(ctx._calls.cbAnswer[0][0], 'menu.saved')
})

test('_close action deletes the message', async () => {
  const { router } = freshRouter()
  const ctx = mkCb({ data: 'm:v1:_close' })
  await router.handleCallback(ctx)
  assert.ok(ctx._calls.delete.length >= 1)
})

test('_noop action answers cbQuery silently', async () => {
  const { router } = freshRouter()
  const ctx = mkCb({ data: 'm:v1:_noop' })
  await router.handleCallback(ctx)
  assert.strictEqual(ctx._calls.cbAnswer.length, 1)
  assert.strictEqual(ctx._calls.editHTML.length, 0)
})

test('handle returns {silent: true} → no cbQuery answer, still re-renders', async () => {
  const { registry, router } = freshRouter()
  registry.registerMenu({
    id: 's',
    access: 'public',
    render: () => ({ text: 'r', keyboard: { inline_keyboard: [] } }),
    handle: async () => ({ silent: true })
  })
  const ctx = mkCb({ data: 'm:v1:s:silent_action' })
  await router.handleCallback(ctx)
  assert.strictEqual(ctx._calls.cbAnswer.length, 0, 'should not answer cbQuery when silent')
  assert.strictEqual(ctx._calls.editHTML.length, 1, 'still re-renders by default')
})

test('handle returns {render: true, state: {...}} → state is passed to render', async () => {
  const { registry, router } = freshRouter()
  let renderState = null
  registry.registerMenu({
    id: 's',
    access: 'public',
    render: (ctx, state) => {
      renderState = state
      return { text: 'r', keyboard: { inline_keyboard: [] } }
    },
    handle: async () => ({ render: true, state: { page: 3, foo: 'bar' } })
  })
  const ctx = mkCb({ data: 'm:v1:s:go' })
  await router.handleCallback(ctx)
  assert.deepStrictEqual(renderState, { page: 3, foo: 'bar' })
})

test('screen.accessOpts hook is called and its return value is passed to checkAccess', async () => {
  const { registry, router } = freshRouter()
  let accessOptsCalled = false
  registry.registerMenu({
    id: 's',
    access: 'group_admin_or_initiator',
    accessOpts: (ctx) => {
      accessOptsCalled = true
      return { initiatorId: ctx.from.id }  // clicker is treated as initiator
    },
    render: () => ({ text: 'r', keyboard: { inline_keyboard: [] } }),
    handle: async () => 'render'
  })
  const ctx = mkCb({ data: 'm:v1:s:open', fromId: 99, getChatMember: async () => ({ status: 'member' }) })
  await router.handleCallback(ctx)
  assert.strictEqual(accessOptsCalled, true)
  // non-admin but matches initiator → allowed → render happens
  assert.strictEqual(ctx._calls.editHTML.length, 1)
})

test('handler errors are caught and answered with menu.error toast', async () => {
  const { registry, router } = freshRouter()
  registry.registerMenu({
    id: 's',
    access: 'public',
    render: () => ({ text: 'x', keyboard: { inline_keyboard: [] } }),
    handle: async () => { throw new Error('boom') }
  })
  const ctx = mkCb({ data: 'm:v1:s:do' })
  await router.handleCallback(ctx)
  assert.strictEqual(ctx._calls.cbAnswer[0][0], 'menu.error')
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) }
    catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
