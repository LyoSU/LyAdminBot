const assert = require('assert')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// Each integration test uses a fresh module graph so registry state is clean.
const fresh = () => {
  delete require.cache[require.resolve('../helpers/menu/registry')]
  delete require.cache[require.resolve('../helpers/menu/router')]
  delete require.cache[require.resolve('../helpers/menu')]
  return require('../helpers/menu')
}

const mkCb = ({ data, fromId = 1, chatId = -100, getChatMember = async () => ({ status: 'administrator' }) }) => {
  const calls = { editText: [], cbAnswer: [], deleted: 0 }
  return {
    callbackQuery: { data, message: { message_id: 50 } },
    chat: { id: chatId },
    from: { id: fromId },
    i18n: { t: (k) => k },
    group: { info: { settings: {} } },
    telegram: {
      getChatMember,
      callApi: async (method, payload) => {
        if (method === 'editMessageText') calls.editText.push(payload)
        if (method === 'answerCallbackQuery') calls.cbAnswer.push(payload)
        return { message_id: 51 }
      }
    },
    deleteMessage: async () => { calls.deleted++; return true },
    answerCbQuery: async (...args) => { calls.cbAnswer.push(args); return true },
    _calls: calls
  }
}

test('full flow: open settings.demo → render → toggle → re-render', async () => {
  const menu = fresh()
  let toggleState = false

  menu.registerMenu({
    id: 'settings.demo',
    access: 'group_admin',
    render: () => ({
      text: `Demo: ${toggleState ? 'ON' : 'OFF'}`,
      keyboard: { inline_keyboard: [[
        { text: toggleState ? '🟢 Вимкнути' : '🔴 Увімкнути', callback_data: menu.cb('settings.demo', 'toggle') }
      ]] }
    }),
    handle: async (ctx, action) => {
      if (action === 'toggle') {
        toggleState = !toggleState
        return 'render'
      }
      return null
    }
  })

  // 1. Open the screen
  const ctx1 = mkCb({ data: 'm:v1:settings.demo:open' })
  await menu.handleCallback(ctx1)
  assert.strictEqual(ctx1._calls.editText.length, 1)
  assert.strictEqual(ctx1._calls.editText[0].text, 'Demo: OFF')

  // 2. Toggle it
  const ctx2 = mkCb({ data: 'm:v1:settings.demo:toggle' })
  await menu.handleCallback(ctx2)
  assert.strictEqual(ctx2._calls.editText.length, 1)
  assert.strictEqual(ctx2._calls.editText[0].text, 'Demo: ON')
})

test('full flow: non-admin denied with toast, no edit', async () => {
  const menu = fresh()
  menu.registerMenu({
    id: 'settings.secret',
    access: 'group_admin',
    render: () => ({ text: 'secret', keyboard: { inline_keyboard: [] } }),
    handle: async () => 'render'
  })
  const ctx = mkCb({
    data: 'm:v1:settings.secret:open',
    getChatMember: async () => ({ status: 'member' })
  })
  await menu.handleCallback(ctx)
  assert.strictEqual(ctx._calls.editText.length, 0)
  assert.ok(ctx._calls.cbAnswer.length >= 1)
})

test('full flow: _close deletes the message', async () => {
  const menu = fresh()
  const ctx = mkCb({ data: 'm:v1:_close' })
  await menu.handleCallback(ctx)
  assert.strictEqual(ctx._calls.deleted, 1)
})

test('full flow: paginated keyboard advances pages via :page:N callback', async () => {
  const menu = fresh()
  menu.registerMenu({
    id: 'list',
    access: 'public',
    render: (ctx, state) => {
      const items = Array.from({ length: 25 }, (_, i) => `i${i}`)
      const p = menu.paginated({ items, page: state.page || 0, perPage: 10, screenId: 'list' })
      return {
        text: `Page ${p.page + 1}/${p.totalPages}: ${p.pageItems.join(',')}`,
        keyboard: { inline_keyboard: [p.nav] }
      }
    },
    handle: async (ctx, action, args) => {
      if (action === 'page') {
        return { render: true, state: { page: parseInt(args[0], 10) } }
      }
      return null
    }
  })

  const ctx = mkCb({ data: 'm:v1:list:page:2' })
  await menu.handleCallback(ctx)
  assert.strictEqual(ctx._calls.editText.length, 1)
  assert.ok(ctx._calls.editText[0].text.startsWith('Page 3/3'))
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
