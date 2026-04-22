# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared infrastructure (Menu Router, reactions, cleanup policy, force-reply chains, replyHTML wrapper) that all subsequent UX modernization plans will sit on top of.

**Architecture:** All inline-menu interactions go through one callback-data namespace `m:v1:<screenId>:<action>:<args>`. A registry maps `screenId` to `{render, handle, access}`. A single dispatcher in `helpers/menu/router.js` validates access, looks up the screen, calls the handler, and re-renders. Menu state (current screen, pagination cursor, ephemeral data) lives in `Group.settings.menuState[]` with TTL. Text input from menus uses `force_reply` + a `pendingInput` field on the group — caught by a new middleware, processed, then UI re-rendered. Reactions and replyHTML are unrelated helpers that go alongside.

**screenId convention:** screen IDs use **dot notation** for hierarchy (e.g., `settings.antispam`, `help.tab`), NOT colons. The colon `:` is reserved as the top-level separator inside callback_data (`m:v1:<screenId>:<action>:<args>`) — having colons inside screenId would break the parser. The design spec writes `settings:antispam` for readability, but the actual registered IDs in code are `settings.antispam`.

**Tech Stack:** Node.js, Telegraf 3.33, Mongoose, plain `node:assert` tests (no jest/mocha — see `tests/is-sender-admin.test.js` as the pattern).

---

## File map

**Create:**
- `helpers/cleanup-policy.js` — TTL constants for auto-delete scenarios
- `helpers/reply-html.js` — `replyHTML(ctx, text, opts)` and `editHTML(ctx, msgId, text, opts)` with link_preview_options + reply_parameters defaults
- `helpers/reactions.js` — `setReaction(ctx, emoji, opts)` with silent fallback
- `helpers/menu/index.js` — public API barrel
- `helpers/menu/registry.js` — `registerMenu`, `getMenu`, `listMenus`
- `helpers/menu/keyboard.js` — `btn`, `row`, `backBtn`, `closeBtn`, `paginated`, `toggleBtn`, `confirmKeyboard`
- `helpers/menu/access.js` — `checkAccess(ctx, accessRule)` returning `{ok, toastKey}`
- `helpers/menu/state.js` — `getState`, `setState`, `clearState`, `cleanupExpired`
- `helpers/menu/router.js` — callback dispatcher (`bot.action(/^m:v1:/)`) + helper `renderScreen`
- `helpers/menu/flows.js` — `startInputFlow(ctx, {type, screen, prompt})` and `consumeInput(ctx)`
- `middlewares/pending-input.js` — middleware that catches replies to active force-reply prompts
- `tests/cleanup-policy.test.js`
- `tests/reply-html.test.js`
- `tests/reactions.test.js`
- `tests/menu-keyboard.test.js`
- `tests/menu-access.test.js`
- `tests/menu-registry.test.js`
- `tests/menu-state.test.js`
- `tests/menu-router.test.js`
- `tests/menu-flows.test.js`
- `tests/pending-input.test.js`

**Modify:**
- `database/models/group.js` — add `menuState[]` and `pendingInput` to schema
- `middlewares/index.js` — export new `pendingInput` middleware
- `bot.js` — register `pendingInput` middleware (between i18n and contextLoader) and register menu router action via new route file
- `routes/index.js` — register new menu route
- `routes/menu.js` (new) — `registerMenuRoutes(bot)` that wires `bot.action(/^m:v1:/, ...)`
- `package.json` — append all new tests to `scripts.test`

**No changes** to existing handlers, locales, or other middlewares in this plan — those happen in subsequent plans.

---

## Test pattern

Every test file uses the `is-sender-admin.test.js` template:

```js
const assert = require('assert')
const { /* function under test */ } = require('../helpers/...')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ... test() blocks ...

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
```

Run a single file with `node tests/<file>.test.js`. Add to `package.json` test script after each new test file is created.

---

## Task 1: cleanup-policy constants

**Files:**
- Create: `helpers/cleanup-policy.js`
- Test: `tests/cleanup-policy.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/cleanup-policy.test.js`:

```js
const assert = require('assert')
const policy = require('../helpers/cleanup-policy')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('exports all expected keys', () => {
  const expected = [
    'cmd_help',
    'cmd_settings_idle',
    'vote_result',
    'mod_event',
    'banan_undo',
    'onboarding_ack',
    'confirm_screen',
    'quick_picker',
    'menu_state'
  ]
  for (const k of expected) {
    assert.ok(typeof policy[k] === 'number' && policy[k] > 0, `missing or non-positive: ${k}`)
  }
})

test('values are in milliseconds (sanity: between 5s and 1h)', () => {
  for (const [k, v] of Object.entries(policy)) {
    assert.ok(v >= 5_000 && v <= 60 * 60_000, `${k}=${v} out of expected range`)
  }
})

test('menu_state is the longest TTL (10min)', () => {
  assert.strictEqual(policy.menu_state, 10 * 60 * 1000)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/cleanup-policy.test.js`
Expected: FAIL — `Cannot find module '../helpers/cleanup-policy'`

- [ ] **Step 3: Implement the helper**

Create `helpers/cleanup-policy.js`:

```js
// Auto-delete TTLs for transient bot messages and menu state.
// All values in milliseconds. Single source of truth — referenced by handlers
// via scheduleDeletion() and by helpers/menu/state.js for state expiry.

module.exports = {
  cmd_help: 60 * 1000,
  cmd_settings_idle: 10 * 60 * 1000,
  vote_result: 2 * 60 * 1000,
  mod_event: 2 * 60 * 1000,
  banan_undo: 60 * 1000,
  onboarding_ack: 30 * 1000,
  confirm_screen: 30 * 1000,
  quick_picker: 30 * 1000,
  menu_state: 10 * 60 * 1000
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/cleanup-policy.test.js`
Expected: `3 passed, 0 failed`

- [ ] **Step 5: Add to package.json and commit**

In `package.json`, append `&& node tests/cleanup-policy.test.js` to the `scripts.test` value.

```bash
git add helpers/cleanup-policy.js tests/cleanup-policy.test.js package.json
git commit -m "feat(menu): add cleanup-policy TTL constants"
```

---

## Task 2: replyHTML wrapper

**Files:**
- Create: `helpers/reply-html.js`
- Test: `tests/reply-html.test.js`

This wraps `ctx.replyWithHTML` to default `link_preview_options.is_disabled = true` (modern Bot API form, replacing deprecated `disable_web_page_preview`) and to set `reply_parameters` from `reply_to_message_id` shorthand. Telegraf 3.33 doesn't natively know about `link_preview_options` — the helper passes it through `ctx.telegram.callApi('sendMessage', ...)` when needed; for now we set BOTH the new and old form so it works on any server-side version.

- [ ] **Step 1: Write the failing test**

Create `tests/reply-html.test.js`:

```js
const assert = require('assert')
const { replyHTML, editHTML } = require('../helpers/reply-html')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = () => {
  const calls = []
  return {
    chat: { id: -100 },
    telegram: {
      callApi: async (method, payload) => { calls.push({ method, payload }); return { message_id: 42 } }
    },
    _calls: calls
  }
}

test('replyHTML sends sendMessage with HTML parse_mode and link_preview disabled', async () => {
  const ctx = mkCtx()
  await replyHTML(ctx, '<b>hi</b>')
  assert.strictEqual(ctx._calls.length, 1)
  const c = ctx._calls[0]
  assert.strictEqual(c.method, 'sendMessage')
  assert.strictEqual(c.payload.chat_id, -100)
  assert.strictEqual(c.payload.text, '<b>hi</b>')
  assert.strictEqual(c.payload.parse_mode, 'HTML')
  assert.deepStrictEqual(c.payload.link_preview_options, { is_disabled: true })
  assert.strictEqual(c.payload.disable_web_page_preview, true)
})

test('replyHTML accepts reply_to_message_id and converts to reply_parameters', async () => {
  const ctx = mkCtx()
  await replyHTML(ctx, 'x', { reply_to_message_id: 7 })
  const c = ctx._calls[0]
  assert.deepStrictEqual(c.payload.reply_parameters, { message_id: 7 })
  // legacy form left intact for telegraf 3.33 compatibility
  assert.strictEqual(c.payload.reply_to_message_id, 7)
})

test('replyHTML passes through reply_markup unchanged', async () => {
  const ctx = mkCtx()
  const kb = { inline_keyboard: [[{ text: 'a', callback_data: 'b' }]] }
  await replyHTML(ctx, 'x', { reply_markup: kb })
  assert.deepStrictEqual(ctx._calls[0].payload.reply_markup, kb)
})

test('replyHTML allows caller to override link_preview defaults', async () => {
  const ctx = mkCtx()
  await replyHTML(ctx, 'x', { link_preview_options: { is_disabled: false } })
  const c = ctx._calls[0]
  assert.deepStrictEqual(c.payload.link_preview_options, { is_disabled: false })
  assert.strictEqual(c.payload.disable_web_page_preview, false)
})

test('editHTML calls editMessageText with same defaults', async () => {
  const ctx = mkCtx()
  await editHTML(ctx, 100, '<i>x</i>')
  const c = ctx._calls[0]
  assert.strictEqual(c.method, 'editMessageText')
  assert.strictEqual(c.payload.chat_id, -100)
  assert.strictEqual(c.payload.message_id, 100)
  assert.strictEqual(c.payload.text, '<i>x</i>')
  assert.strictEqual(c.payload.parse_mode, 'HTML')
  assert.deepStrictEqual(c.payload.link_preview_options, { is_disabled: true })
})

test('editHTML returns the edited message id from telegram', async () => {
  const ctx = mkCtx()
  const result = await editHTML(ctx, 100, 'x')
  assert.strictEqual(result.message_id, 42)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/reply-html.test.js`
Expected: FAIL — `Cannot find module '../helpers/reply-html'`

- [ ] **Step 3: Implement the helper**

Create `helpers/reply-html.js`:

```js
// Centralized HTML reply/edit helpers.
//
// - Always sets parse_mode HTML.
// - Defaults link previews OFF (modern link_preview_options + legacy
//   disable_web_page_preview for telegraf 3.33 backward-compat).
// - Accepts reply_to_message_id shorthand and emits modern reply_parameters
//   alongside the legacy field.
// - Bypasses telegraf's chunked sendMessage helpers and goes through callApi
//   so we can pass new Bot API fields without telegraf knowing about them.

const buildPayload = (chatId, text, opts = {}) => {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...opts
  }

  // Link preview defaults (modern + legacy). Caller can override either.
  if (payload.link_preview_options === undefined) {
    payload.link_preview_options = { is_disabled: true }
  }
  if (payload.disable_web_page_preview === undefined) {
    payload.disable_web_page_preview = payload.link_preview_options.is_disabled !== false
  } else {
    // honor explicit override of legacy form
  }
  if (payload.link_preview_options.is_disabled === false && opts.disable_web_page_preview === undefined) {
    payload.disable_web_page_preview = false
  }

  // reply_to_message_id → reply_parameters (keep both)
  if (payload.reply_to_message_id !== undefined && payload.reply_parameters === undefined) {
    payload.reply_parameters = { message_id: payload.reply_to_message_id }
  }

  return payload
}

const replyHTML = (ctx, text, opts = {}) => {
  const payload = buildPayload(ctx.chat.id, text, opts)
  return ctx.telegram.callApi('sendMessage', payload)
}

const editHTML = (ctx, messageId, text, opts = {}) => {
  const payload = buildPayload(ctx.chat.id, text, opts)
  payload.message_id = messageId
  return ctx.telegram.callApi('editMessageText', payload)
}

module.exports = { replyHTML, editHTML }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/reply-html.test.js`
Expected: `6 passed, 0 failed`

- [ ] **Step 5: Add to package.json and commit**

Append `&& node tests/reply-html.test.js` to `package.json` `scripts.test`.

```bash
git add helpers/reply-html.js tests/reply-html.test.js package.json
git commit -m "feat(menu): add replyHTML/editHTML wrappers with link_preview_options"
```

---

## Task 3: reactions helper

**Files:**
- Create: `helpers/reactions.js`
- Test: `tests/reactions.test.js`

Wraps `setMessageReaction` (Bot API 7.0+). Falls back silently when the API rejects — common causes: bot is not admin, chat disabled reactions, message too old.

- [ ] **Step 1: Write the failing test**

Create `tests/reactions.test.js`:

```js
const assert = require('assert')
const { setReaction, ack, ackOnTarget, silent, REACTIONS } = require('../helpers/reactions')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = ({ throws } = {}) => {
  const calls = []
  return {
    chat: { id: -100 },
    message: { message_id: 5 },
    telegram: {
      callApi: async (method, payload) => {
        calls.push({ method, payload })
        if (throws) throw new Error(throws)
        return true
      }
    },
    _calls: calls
  }
}

test('REACTIONS exports the agreed emoji vocabulary', () => {
  for (const k of ['del', 'banan', 'report', 'extraSaved', 'trustOk']) {
    assert.ok(typeof REACTIONS[k] === 'string' && REACTIONS[k].length > 0, `missing: ${k}`)
  }
})

test('setReaction calls setMessageReaction with emoji-type reaction', async () => {
  const ctx = mkCtx()
  await setReaction(ctx, -100, 5, '🍌')
  assert.strictEqual(ctx._calls.length, 1)
  const c = ctx._calls[0]
  assert.strictEqual(c.method, 'setMessageReaction')
  assert.strictEqual(c.payload.chat_id, -100)
  assert.strictEqual(c.payload.message_id, 5)
  assert.deepStrictEqual(c.payload.reaction, [{ type: 'emoji', emoji: '🍌' }])
})

test('setReaction with empty emoji clears the reaction', async () => {
  const ctx = mkCtx()
  await setReaction(ctx, -100, 5, null)
  const c = ctx._calls[0]
  assert.deepStrictEqual(c.payload.reaction, [])
})

test('setReaction swallows errors and returns false', async () => {
  const ctx = mkCtx({ throws: 'reactions disabled' })
  const result = await setReaction(ctx, -100, 5, '🍌')
  assert.strictEqual(result, false)
})

test('setReaction returns true on success', async () => {
  const ctx = mkCtx()
  const result = await setReaction(ctx, -100, 5, '🍌')
  assert.strictEqual(result, true)
})

test('ack reacts to ctx.message.message_id in ctx.chat', async () => {
  const ctx = mkCtx()
  await ack(ctx, '✓')
  const c = ctx._calls[0]
  assert.strictEqual(c.payload.chat_id, -100)
  assert.strictEqual(c.payload.message_id, 5)
})

test('ackOnTarget reacts to a specific message id', async () => {
  const ctx = mkCtx()
  await ackOnTarget(ctx, 999, '🚫')
  assert.strictEqual(ctx._calls[0].payload.message_id, 999)
})

test('silent uses REACTIONS.report (👀)', async () => {
  const ctx = mkCtx()
  await silent(ctx)
  assert.strictEqual(ctx._calls[0].payload.reaction[0].emoji, REACTIONS.report)
})

test('ack with no ctx.message is a no-op (no API call, returns false)', async () => {
  const ctx = { chat: { id: -100 }, telegram: { callApi: async () => { throw new Error('should not call') } } }
  const result = await ack(ctx, '✓')
  assert.strictEqual(result, false)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/reactions.test.js`
Expected: FAIL — `Cannot find module '../helpers/reactions'`

- [ ] **Step 3: Implement the helper**

Create `helpers/reactions.js`:

```js
const { bot: log } = require('./logger')

const REACTIONS = {
  del: '🗑',
  banan: '🍌',
  report: '👀',
  extraSaved: '✍️',
  trustOk: '👌',
  voteSpam: '🚫',
  voteClean: '✅',
  ok: '👍'
}

const setReaction = async (ctx, chatId, messageId, emoji) => {
  if (!ctx || !ctx.telegram) return false
  if (!chatId || !messageId) return false
  try {
    await ctx.telegram.callApi('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: 'emoji', emoji }] : []
    })
    return true
  } catch (err) {
    log.debug({ err: err.message, chatId, messageId, emoji }, 'setMessageReaction failed (silently dropped)')
    return false
  }
}

const ack = (ctx, emoji) => {
  if (!ctx || !ctx.chat || !ctx.message || !ctx.message.message_id) return Promise.resolve(false)
  return setReaction(ctx, ctx.chat.id, ctx.message.message_id, emoji)
}

const ackOnTarget = (ctx, messageId, emoji) => {
  if (!ctx || !ctx.chat) return Promise.resolve(false)
  return setReaction(ctx, ctx.chat.id, messageId, emoji)
}

const silent = (ctx) => ack(ctx, REACTIONS.report)

module.exports = { setReaction, ack, ackOnTarget, silent, REACTIONS }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/reactions.test.js`
Expected: `9 passed, 0 failed`

- [ ] **Step 5: Add to package.json and commit**

Append `&& node tests/reactions.test.js` to `package.json` test script.

```bash
git add helpers/reactions.js tests/reactions.test.js package.json
git commit -m "feat(menu): add reactions helper with silent fallback"
```

---

## Task 4: Menu keyboard builders

**Files:**
- Create: `helpers/menu/keyboard.js`
- Test: `tests/menu-keyboard.test.js`

Pure functions that produce inline_keyboard arrays. No telegraf imports.

- [ ] **Step 1: Write the failing test**

Create `tests/menu-keyboard.test.js`:

```js
const assert = require('assert')
const {
  btn, row, backBtn, closeBtn, toggleBtn, paginated, confirmKeyboard, cb
} = require('../helpers/menu/keyboard')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('cb builds m:v1: prefixed callback_data', () => {
  assert.strictEqual(cb('settings', 'open'), 'm:v1:settings:open')
  assert.strictEqual(cb('ban', 'do', '123', '300'), 'm:v1:ban:do:123:300')
})

test('cb truncates payload at 64 bytes (Telegram limit)', () => {
  const long = 'x'.repeat(80)
  const result = cb('s', 'a', long)
  assert.ok(Buffer.byteLength(result, 'utf8') <= 64)
})

test('btn builds an inline button object', () => {
  assert.deepStrictEqual(btn('Hi', 'm:v1:x:y'), { text: 'Hi', callback_data: 'm:v1:x:y' })
})

test('btn passes icon_custom_emoji_id when provided', () => {
  assert.deepStrictEqual(
    btn('Hi', 'd', { iconEmojiId: '123' }),
    { text: 'Hi', callback_data: 'd', icon_custom_emoji_id: '123' }
  )
})

test('btn passes url instead of callback_data when given', () => {
  assert.deepStrictEqual(btn('Open', null, { url: 'https://t.me' }), { text: 'Open', url: 'https://t.me' })
})

test('row wraps buttons into an array', () => {
  const a = btn('A', 'a'); const b = btn('B', 'b')
  assert.deepStrictEqual(row(a, b), [a, b])
})

test('row filters falsy entries (so callers can use conditionals)', () => {
  const a = btn('A', 'a')
  assert.deepStrictEqual(row(a, false, null, undefined), [a])
})

test('backBtn produces a back button to a target screen', () => {
  const b = backBtn('settings.root')
  assert.strictEqual(b.text, '← Назад')
  assert.strictEqual(b.callback_data, 'm:v1:settings.root:open')
})

test('backBtn accepts custom label', () => {
  const b = backBtn('s.r', { label: '⬅' })
  assert.strictEqual(b.text, '⬅')
})

test('closeBtn produces a close button (router knows to delete)', () => {
  const b = closeBtn()
  assert.strictEqual(b.text, '✕ Закрити')
  assert.strictEqual(b.callback_data, 'm:v1:_close')
})

test('toggleBtn shows green dot when on, red when off', () => {
  const on = toggleBtn({ label: 'Антиспам', on: true, callback: 'm:v1:s:t:off' })
  const off = toggleBtn({ label: 'Антиспам', on: false, callback: 'm:v1:s:t:on' })
  assert.ok(on.text.startsWith('🟢'))
  assert.ok(off.text.startsWith('🔴'))
})

test('paginated produces ‹ N/M › nav row when multiple pages', () => {
  const items = Array.from({ length: 25 }, (_, i) => `item${i}`)
  const result = paginated({ items, page: 1, perPage: 10, screenId: 'list' })
  assert.strictEqual(result.pageItems.length, 10)
  assert.deepStrictEqual(result.pageItems, items.slice(10, 20))
  assert.strictEqual(result.nav.length, 3)
  assert.strictEqual(result.nav[0].text, '‹')
  assert.strictEqual(result.nav[1].text, '2 / 3')
  assert.strictEqual(result.nav[2].text, '›')
  assert.strictEqual(result.nav[0].callback_data, 'm:v1:list:page:0')
  assert.strictEqual(result.nav[2].callback_data, 'm:v1:list:page:2')
})

test('paginated returns empty nav when only one page', () => {
  const items = ['a', 'b']
  const result = paginated({ items, page: 0, perPage: 10, screenId: 'list' })
  assert.strictEqual(result.nav.length, 0)
  assert.strictEqual(result.pageItems.length, 2)
})

test('paginated clamps page to valid range', () => {
  const items = Array.from({ length: 25 }, (_, i) => i)
  const high = paginated({ items, page: 99, perPage: 10, screenId: 'list' })
  assert.strictEqual(high.page, 2)
  const low = paginated({ items, page: -5, perPage: 10, screenId: 'list' })
  assert.strictEqual(low.page, 0)
})

test('paginated nav at first page disables ‹ (callback_data === noop)', () => {
  const items = Array.from({ length: 25 }, (_, i) => i)
  const result = paginated({ items, page: 0, perPage: 10, screenId: 'list' })
  assert.strictEqual(result.nav[0].callback_data, 'm:v1:_noop')
})

test('paginated nav at last page disables ›', () => {
  const items = Array.from({ length: 25 }, (_, i) => i)
  const result = paginated({ items, page: 2, perPage: 10, screenId: 'list' })
  assert.strictEqual(result.nav[2].callback_data, 'm:v1:_noop')
})

test('cb works with dotted screenId', () => {
  assert.strictEqual(cb('settings.antispam', 'toggle'), 'm:v1:settings.antispam:toggle')
})

test('confirmKeyboard returns Yes / No row', () => {
  const kb = confirmKeyboard({
    yesLabel: 'Так', yesCallback: 'm:v1:s:do',
    noLabel: 'Ні', noCallback: 'm:v1:s:cancel'
  })
  assert.strictEqual(kb.inline_keyboard.length, 1)
  assert.strictEqual(kb.inline_keyboard[0].length, 2)
  assert.strictEqual(kb.inline_keyboard[0][0].text, 'Так')
  assert.strictEqual(kb.inline_keyboard[0][1].text, 'Ні')
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/menu-keyboard.test.js`
Expected: FAIL — `Cannot find module '../helpers/menu/keyboard'`

- [ ] **Step 3: Implement the builders**

Create directory `helpers/menu/` and file `helpers/menu/keyboard.js`:

```js
// Pure inline-keyboard builders for the unified Menu Router.
// All callback_data strings start with the prefix `m:v1:`.

const PREFIX = 'm:v1:'
const NOOP = `${PREFIX}_noop`
const CLOSE = `${PREFIX}_close`
const MAX_CB_BYTES = 64

const cb = (...parts) => {
  const raw = PREFIX + parts.filter(p => p !== undefined && p !== null).join(':')
  if (Buffer.byteLength(raw, 'utf8') <= MAX_CB_BYTES) return raw
  // Truncate trailing bytes safely (won't split a multibyte char).
  const buf = Buffer.from(raw, 'utf8')
  let end = MAX_CB_BYTES
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--
  return buf.slice(0, end).toString('utf8')
}

const btn = (text, callbackData, opts = {}) => {
  const o = { text }
  if (opts.url) {
    o.url = opts.url
  } else {
    o.callback_data = callbackData
  }
  if (opts.iconEmojiId) o.icon_custom_emoji_id = opts.iconEmojiId
  if (opts.loginUrl) o.login_url = opts.loginUrl
  return o
}

const row = (...buttons) => buttons.filter(Boolean)

const backBtn = (toScreenId, opts = {}) => btn(
  opts.label || '← Назад',
  cb(toScreenId, 'open')
)

const closeBtn = (opts = {}) => btn(opts.label || '✕ Закрити', CLOSE)

const toggleBtn = ({ label, on, callback, iconEmojiId }) => btn(
  `${on ? '🟢' : '🔴'} ${label}`,
  callback,
  iconEmojiId ? { iconEmojiId } : {}
)

const paginated = ({ items, page = 0, perPage = 10, screenId }) => {
  const total = Math.max(1, Math.ceil(items.length / perPage))
  const safePage = Math.max(0, Math.min(page, total - 1))
  const start = safePage * perPage
  const pageItems = items.slice(start, start + perPage)

  if (total <= 1) {
    return { pageItems, page: safePage, totalPages: total, nav: [] }
  }

  const prevCb = safePage > 0 ? cb(screenId, 'page', String(safePage - 1)) : NOOP
  const nextCb = safePage < total - 1 ? cb(screenId, 'page', String(safePage + 1)) : NOOP

  const nav = [
    btn('‹', prevCb),
    btn(`${safePage + 1} / ${total}`, NOOP),
    btn('›', nextCb)
  ]

  return { pageItems, page: safePage, totalPages: total, nav }
}

const confirmKeyboard = ({ yesLabel, yesCallback, noLabel, noCallback }) => ({
  inline_keyboard: [[
    btn(yesLabel, yesCallback),
    btn(noLabel, noCallback)
  ]]
})

module.exports = {
  PREFIX,
  NOOP,
  CLOSE,
  MAX_CB_BYTES,
  cb,
  btn,
  row,
  backBtn,
  closeBtn,
  toggleBtn,
  paginated,
  confirmKeyboard
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/menu-keyboard.test.js`
Expected: `18 passed, 0 failed`

- [ ] **Step 5: Add to package.json and commit**

Append `&& node tests/menu-keyboard.test.js` to test script.

```bash
git add helpers/menu/keyboard.js tests/menu-keyboard.test.js package.json
git commit -m "feat(menu): add keyboard builders (btn/row/back/close/paginated/toggle/confirm)"
```

---

## Task 5: Menu access guards

**Files:**
- Create: `helpers/menu/access.js`
- Test: `tests/menu-access.test.js`

Pluggable access rules: `'public'`, `'group_admin'`, `'initiator'`, `'group_admin_or_initiator'`. Returns `{ ok, toastKey }` so the router can answerCbQuery with a localized message.

- [ ] **Step 1: Write the failing test**

Create `tests/menu-access.test.js`:

```js
const assert = require('assert')
const { checkAccess } = require('../helpers/menu/access')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCb = ({ fromId, chatId, originatorId, getChatMember }) => ({
  from: { id: fromId },
  chat: { id: chatId },
  callbackQuery: { message: { reply_to_message: { from: { id: originatorId } } } },
  telegram: {
    getChatMember: getChatMember || (async () => ({ status: 'member' }))
  }
})

test('public access always passes', async () => {
  const ctx = mkCb({ fromId: 1, chatId: -100 })
  const result = await checkAccess(ctx, 'public')
  assert.strictEqual(result.ok, true)
})

test('group_admin passes for administrator', async () => {
  const ctx = mkCb({
    fromId: 1, chatId: -100,
    getChatMember: async () => ({ status: 'administrator' })
  })
  const result = await checkAccess(ctx, 'group_admin')
  assert.strictEqual(result.ok, true)
})

test('group_admin passes for creator', async () => {
  const ctx = mkCb({
    fromId: 1, chatId: -100,
    getChatMember: async () => ({ status: 'creator' })
  })
  const result = await checkAccess(ctx, 'group_admin')
  assert.strictEqual(result.ok, true)
})

test('group_admin denies regular member with toastKey', async () => {
  const ctx = mkCb({
    fromId: 1, chatId: -100,
    getChatMember: async () => ({ status: 'member' })
  })
  const result = await checkAccess(ctx, 'group_admin')
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.toastKey, 'menu.access.only_admins')
})

test('initiator passes when from.id matches initiatorId option', async () => {
  const ctx = mkCb({ fromId: 42, chatId: -100 })
  const result = await checkAccess(ctx, 'initiator', { initiatorId: 42 })
  assert.strictEqual(result.ok, true)
})

test('initiator denies when from.id does not match', async () => {
  const ctx = mkCb({ fromId: 99, chatId: -100 })
  const result = await checkAccess(ctx, 'initiator', { initiatorId: 42 })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.toastKey, 'menu.access.only_initiator')
})

test('group_admin_or_initiator passes for matching initiator who is not admin', async () => {
  const ctx = mkCb({
    fromId: 42, chatId: -100,
    getChatMember: async () => ({ status: 'member' })
  })
  const result = await checkAccess(ctx, 'group_admin_or_initiator', { initiatorId: 42 })
  assert.strictEqual(result.ok, true)
})

test('group_admin_or_initiator passes for any admin even without initiator match', async () => {
  const ctx = mkCb({
    fromId: 99, chatId: -100,
    getChatMember: async () => ({ status: 'administrator' })
  })
  const result = await checkAccess(ctx, 'group_admin_or_initiator', { initiatorId: 42 })
  assert.strictEqual(result.ok, true)
})

test('group_admin_or_initiator denies non-admin non-initiator', async () => {
  const ctx = mkCb({
    fromId: 99, chatId: -100,
    getChatMember: async () => ({ status: 'member' })
  })
  const result = await checkAccess(ctx, 'group_admin_or_initiator', { initiatorId: 42 })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.toastKey, 'menu.access.only_initiator_or_admin')
})

test('unknown rule denies with generic toastKey', async () => {
  const ctx = mkCb({ fromId: 1, chatId: -100 })
  const result = await checkAccess(ctx, 'mystery_rule')
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.toastKey, 'menu.access.denied')
})

test('group_admin denies if getChatMember throws', async () => {
  const ctx = mkCb({
    fromId: 1, chatId: -100,
    getChatMember: async () => { throw new Error('API down') }
  })
  const result = await checkAccess(ctx, 'group_admin')
  assert.strictEqual(result.ok, false)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/menu-access.test.js`
Expected: FAIL — `Cannot find module '../helpers/menu/access'`

- [ ] **Step 3: Implement guards**

Create `helpers/menu/access.js`:

```js
const ADMIN_STATUSES = new Set(['creator', 'administrator'])

const isAdmin = async (ctx) => {
  if (!ctx || !ctx.chat || !ctx.from) return false
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id)
    return Boolean(member && ADMIN_STATUSES.has(member.status))
  } catch {
    return false
  }
}

const isInitiator = (ctx, initiatorId) => {
  return Boolean(initiatorId && ctx.from && ctx.from.id === initiatorId)
}

const checkAccess = async (ctx, rule, opts = {}) => {
  switch (rule) {
    case 'public':
      return { ok: true }
    case 'group_admin':
      return (await isAdmin(ctx))
        ? { ok: true }
        : { ok: false, toastKey: 'menu.access.only_admins' }
    case 'initiator':
      return isInitiator(ctx, opts.initiatorId)
        ? { ok: true }
        : { ok: false, toastKey: 'menu.access.only_initiator' }
    case 'group_admin_or_initiator':
      if (isInitiator(ctx, opts.initiatorId)) return { ok: true }
      if (await isAdmin(ctx)) return { ok: true }
      return { ok: false, toastKey: 'menu.access.only_initiator_or_admin' }
    default:
      return { ok: false, toastKey: 'menu.access.denied' }
  }
}

module.exports = { checkAccess, isAdmin, isInitiator }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/menu-access.test.js`
Expected: `11 passed, 0 failed`

- [ ] **Step 5: Add to package.json and commit**

Append `&& node tests/menu-access.test.js` to test script.

```bash
git add helpers/menu/access.js tests/menu-access.test.js package.json
git commit -m "feat(menu): add access guards (public/group_admin/initiator/group_admin_or_initiator)"
```

---

## Task 6: Menu registry

**Files:**
- Create: `helpers/menu/registry.js`
- Test: `tests/menu-registry.test.js`

In-process registry (Map). Each screen has `{id, render, handle, access}`. Throws on duplicate registration to catch wiring bugs early.

- [ ] **Step 1: Write the failing test**

Create `tests/menu-registry.test.js`:

```js
const assert = require('assert')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// Reset registry between tests by re-requiring fresh module
const freshRegistry = () => {
  delete require.cache[require.resolve('../helpers/menu/registry')]
  return require('../helpers/menu/registry')
}

test('registerMenu stores screen and getMenu retrieves it', () => {
  const reg = freshRegistry()
  const screen = { id: 's:r', access: 'public', render: () => ({}), handle: () => {} }
  reg.registerMenu(screen)
  assert.strictEqual(reg.getMenu('s:r'), screen)
})

test('registerMenu throws on duplicate id', () => {
  const reg = freshRegistry()
  reg.registerMenu({ id: 'dup', access: 'public', render: () => ({}), handle: () => {} })
  assert.throws(
    () => reg.registerMenu({ id: 'dup', access: 'public', render: () => ({}), handle: () => {} }),
    /already registered/
  )
})

test('registerMenu validates required fields', () => {
  const reg = freshRegistry()
  assert.throws(() => reg.registerMenu({}), /id is required/)
  assert.throws(() => reg.registerMenu({ id: 'x' }), /access is required/)
  assert.throws(() => reg.registerMenu({ id: 'x', access: 'public' }), /render is required/)
  assert.throws(
    () => reg.registerMenu({ id: 'x', access: 'public', render: () => ({}) }),
    /handle is required/
  )
})

test('getMenu returns undefined for unknown id', () => {
  const reg = freshRegistry()
  assert.strictEqual(reg.getMenu('does-not-exist'), undefined)
})

test('listMenus returns ids of all registered screens', () => {
  const reg = freshRegistry()
  reg.registerMenu({ id: 'a', access: 'public', render: () => ({}), handle: () => {} })
  reg.registerMenu({ id: 'b', access: 'public', render: () => ({}), handle: () => {} })
  const ids = reg.listMenus()
  assert.deepStrictEqual(ids.sort(), ['a', 'b'])
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/menu-registry.test.js`
Expected: FAIL — `Cannot find module '../helpers/menu/registry'`

- [ ] **Step 3: Implement registry**

Create `helpers/menu/registry.js`:

```js
const screens = new Map()

const registerMenu = (screen) => {
  if (!screen || !screen.id) throw new Error('menu: id is required')
  if (!screen.access) throw new Error(`menu[${screen.id}]: access is required`)
  if (typeof screen.render !== 'function') throw new Error(`menu[${screen.id}]: render is required (function)`)
  if (typeof screen.handle !== 'function') throw new Error(`menu[${screen.id}]: handle is required (function)`)
  if (screens.has(screen.id)) throw new Error(`menu[${screen.id}]: already registered`)
  screens.set(screen.id, screen)
  return screen
}

const getMenu = (id) => screens.get(id)

const listMenus = () => Array.from(screens.keys())

module.exports = { registerMenu, getMenu, listMenus }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/menu-registry.test.js`
Expected: `5 passed, 0 failed`

- [ ] **Step 5: Add to package.json and commit**

Append `&& node tests/menu-registry.test.js` to test script.

```bash
git add helpers/menu/registry.js tests/menu-registry.test.js package.json
git commit -m "feat(menu): add screen registry"
```

---

## Task 7: Add menuState/pendingInput to Group schema

**Files:**
- Modify: `database/models/group.js`

Adds two new sub-fields to `settings`:
- `menuState: [{ userId, screen, data, expiresAt }]` — short-lived navigation state per user (TTL applied at read-time, not by Mongo TTL index, because we need finer-grained per-entry expiry)
- `pendingInput: { userId, type, screen, expiresAt, promptMsgId }` — single active force-reply prompt per group

No new test file — schema change is exercised by Task 8 (state) and Task 11 (pending-input middleware) integration tests.

- [ ] **Step 1: Modify the schema**

In `database/models/group.js`, inside the `settings` object (after `openaiSpamCheck`, before the closing `}` of `settings`), add:

```js
    menuState: {
      type: [{
        userId: { type: Number },
        screen: { type: String },
        data: { type: mongoose.Schema.Types.Mixed },
        expiresAt: { type: Date }
      }],
      default: []
    },
    pendingInput: {
      userId: { type: Number },
      type: { type: String },
      screen: { type: String },
      expiresAt: { type: Date },
      promptMsgId: { type: Number }
    }
```

So the `settings` object now ends with `..., openaiSpamCheck: {...}, menuState: [...], pendingInput: {...} }`.

- [ ] **Step 2: Verify the schema parses without error**

Run: `node -e "require('./database/models/group')"`
Expected: exits 0 with no output (schema compiled successfully)

- [ ] **Step 3: Commit**

```bash
git add database/models/group.js
git commit -m "feat(menu): add menuState/pendingInput fields to Group settings schema"
```

---

## Task 8: Menu state (read/write/expire)

**Files:**
- Create: `helpers/menu/state.js`
- Test: `tests/menu-state.test.js`

Pure-function helpers operating on a `group.info.settings.menuState` array. TTL applied at read-time (so an explicit read returns null after expiry, no need to rely on Mongo TTL).

- [ ] **Step 1: Write the failing test**

Create `tests/menu-state.test.js`:

```js
const assert = require('assert')
const { getState, setState, clearState, cleanupExpired } = require('../helpers/menu/state')
const policy = require('../helpers/cleanup-policy')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkGroup = (entries = []) => ({
  settings: { menuState: entries.map(e => ({ ...e })) }
})

test('setState appends a new entry with expiresAt = now + menu_state TTL', () => {
  const group = mkGroup()
  const before = Date.now()
  setState(group, 42, 's:r', { page: 1 })
  assert.strictEqual(group.settings.menuState.length, 1)
  const e = group.settings.menuState[0]
  assert.strictEqual(e.userId, 42)
  assert.strictEqual(e.screen, 's:r')
  assert.deepStrictEqual(e.data, { page: 1 })
  const expectedExpiry = before + policy.menu_state
  assert.ok(Math.abs(e.expiresAt.getTime() - expectedExpiry) < 5_000)
})

test('setState replaces existing entry for the same user (no duplicates)', () => {
  const group = mkGroup()
  setState(group, 42, 's:r', { page: 1 })
  setState(group, 42, 's:r', { page: 2 })
  assert.strictEqual(group.settings.menuState.length, 1)
  assert.deepStrictEqual(group.settings.menuState[0].data, { page: 2 })
})

test('setState keeps separate entries for different users', () => {
  const group = mkGroup()
  setState(group, 42, 's:r', { a: 1 })
  setState(group, 99, 's:r', { b: 2 })
  assert.strictEqual(group.settings.menuState.length, 2)
})

test('getState returns the entry data for the user/screen', () => {
  const group = mkGroup()
  setState(group, 42, 's:r', { page: 3 })
  assert.deepStrictEqual(getState(group, 42, 's:r'), { page: 3 })
})

test('getState returns null for missing entry', () => {
  const group = mkGroup()
  assert.strictEqual(getState(group, 42, 's:r'), null)
})

test('getState returns null for expired entry and removes it from array', () => {
  const group = mkGroup([{
    userId: 42, screen: 's:r', data: { x: 1 },
    expiresAt: new Date(Date.now() - 1000)
  }])
  assert.strictEqual(getState(group, 42, 's:r'), null)
  assert.strictEqual(group.settings.menuState.length, 0)
})

test('clearState removes the entry', () => {
  const group = mkGroup()
  setState(group, 42, 's:r', {})
  clearState(group, 42, 's:r')
  assert.strictEqual(group.settings.menuState.length, 0)
})

test('clearState is no-op for missing entry', () => {
  const group = mkGroup()
  clearState(group, 42, 's:r')
  assert.strictEqual(group.settings.menuState.length, 0)
})

test('cleanupExpired removes only expired entries', () => {
  const group = mkGroup([
    { userId: 1, screen: 'a', data: {}, expiresAt: new Date(Date.now() - 1000) },
    { userId: 2, screen: 'b', data: {}, expiresAt: new Date(Date.now() + 60_000) }
  ])
  cleanupExpired(group)
  assert.strictEqual(group.settings.menuState.length, 1)
  assert.strictEqual(group.settings.menuState[0].userId, 2)
})

test('handles missing settings.menuState gracefully (initializes)', () => {
  const group = { settings: {} }
  setState(group, 1, 's', { x: 1 })
  assert.strictEqual(group.settings.menuState.length, 1)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/menu-state.test.js`
Expected: FAIL — `Cannot find module '../helpers/menu/state'`

- [ ] **Step 3: Implement state helpers**

Create `helpers/menu/state.js`:

```js
const policy = require('../cleanup-policy')

const ensureArray = (group) => {
  if (!group.settings) group.settings = {}
  if (!Array.isArray(group.settings.menuState)) group.settings.menuState = []
  return group.settings.menuState
}

const findIndex = (arr, userId, screen) =>
  arr.findIndex(e => e.userId === userId && e.screen === screen)

const isExpired = (entry) => entry.expiresAt && entry.expiresAt.getTime() < Date.now()

const setState = (group, userId, screen, data) => {
  const arr = ensureArray(group)
  const idx = findIndex(arr, userId, screen)
  const entry = {
    userId,
    screen,
    data,
    expiresAt: new Date(Date.now() + policy.menu_state)
  }
  if (idx >= 0) arr[idx] = entry
  else arr.push(entry)
}

const getState = (group, userId, screen) => {
  const arr = ensureArray(group)
  const idx = findIndex(arr, userId, screen)
  if (idx < 0) return null
  if (isExpired(arr[idx])) {
    arr.splice(idx, 1)
    return null
  }
  return arr[idx].data
}

const clearState = (group, userId, screen) => {
  const arr = ensureArray(group)
  const idx = findIndex(arr, userId, screen)
  if (idx >= 0) arr.splice(idx, 1)
}

const cleanupExpired = (group) => {
  const arr = ensureArray(group)
  for (let i = arr.length - 1; i >= 0; i--) {
    if (isExpired(arr[i])) arr.splice(i, 1)
  }
}

module.exports = { setState, getState, clearState, cleanupExpired }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/menu-state.test.js`
Expected: `10 passed, 0 failed`

- [ ] **Step 5: Add to package.json and commit**

Append `&& node tests/menu-state.test.js` to test script.

```bash
git add helpers/menu/state.js tests/menu-state.test.js package.json
git commit -m "feat(menu): add menu state helpers (TTL-aware get/set/clear)"
```

---

## Task 9: Menu router (callback dispatcher)

**Files:**
- Create: `helpers/menu/router.js`
- Test: `tests/menu-router.test.js`

The router parses `m:v1:<screenId>:<action>:<args...>` callback_data, looks up the screen in the registry, runs access guard, dispatches to the screen's `handle`, and re-renders. It also handles two reserved actions: `_close` (delete the message) and `_noop` (silently answerCbQuery). The `open` action means "render this screen fresh".

- [ ] **Step 1: Write the failing test**

Create `tests/menu-router.test.js`:

```js
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
  // toast was answered
  assert.strictEqual(ctx._calls.cbAnswer.length, 1)
  // no edit performed
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/menu-router.test.js`
Expected: FAIL — `Cannot find module '../helpers/menu/router'`

- [ ] **Step 3: Implement the router**

Create `helpers/menu/router.js`:

```js
const { getMenu } = require('./registry')
const { checkAccess } = require('./access')
const { editHTML } = require('../reply-html')
const { PREFIX } = require('./keyboard')
const { bot: log } = require('../logger')

const RESERVED_CLOSE = '_close'
const RESERVED_NOOP = '_noop'

const parseCallback = (data) => {
  if (typeof data !== 'string' || !data.startsWith(PREFIX)) {
    return { ok: false }
  }
  const rest = data.slice(PREFIX.length)
  const parts = rest.split(':')
  if (parts.length === 0 || parts[0] === '') return { ok: false }

  // Reserved single-token actions
  if (parts.length === 1 && (parts[0] === RESERVED_CLOSE || parts[0] === RESERVED_NOOP)) {
    return { ok: true, screenId: parts[0], action: '', args: [] }
  }
  if (parts.length < 2) return { ok: false }

  const [screenId, action, ...args] = parts
  return { ok: true, screenId, action, args }
}

const renderScreen = async (ctx, screen, state) => {
  const view = await screen.render(ctx, state || {})
  if (!view || !view.text) return
  const opts = {}
  if (view.keyboard) opts.reply_markup = view.keyboard
  try {
    await editHTML(ctx, ctx.callbackQuery.message.message_id, view.text, opts)
  } catch (err) {
    if (!err.message || !err.message.includes('message is not modified')) {
      log.warn({ err: err.message, screenId: screen.id }, 'menu render: editHTML failed')
    }
  }
}

const handleCallback = async (ctx) => {
  const data = ctx.callbackQuery && ctx.callbackQuery.data
  const parsed = parseCallback(data)
  if (!parsed.ok) {
    return ctx.answerCbQuery(ctx.i18n.t('menu.unknown')).catch(() => {})
  }

  // Reserved actions
  if (parsed.screenId === RESERVED_CLOSE) {
    try { await ctx.deleteMessage() } catch { /* ignore */ }
    return ctx.answerCbQuery().catch(() => {})
  }
  if (parsed.screenId === RESERVED_NOOP) {
    return ctx.answerCbQuery().catch(() => {})
  }

  const screen = getMenu(parsed.screenId)
  if (!screen) {
    return ctx.answerCbQuery(ctx.i18n.t('menu.unknown')).catch(() => {})
  }

  const access = await checkAccess(ctx, screen.access, parsed.accessOpts || {})
  if (!access.ok) {
    return ctx.answerCbQuery(ctx.i18n.t(access.toastKey), { show_alert: true }).catch(() => {})
  }

  try {
    let result
    if (parsed.action === 'open') {
      result = 'render'
    } else {
      result = await screen.handle(ctx, parsed.action, parsed.args)
    }

    if (result === 'render' || (result && result.render !== false)) {
      await renderScreen(ctx, screen, result && result.state)
    }
    if (result && result.toast) {
      await ctx.answerCbQuery(ctx.i18n.t(result.toast)).catch(() => {})
    } else if (!result || !result.silent) {
      await ctx.answerCbQuery().catch(() => {})
    }
  } catch (err) {
    log.error({ err: err.message, screenId: parsed.screenId, action: parsed.action }, 'menu handler error')
    await ctx.answerCbQuery(ctx.i18n.t('menu.error'), { show_alert: false }).catch(() => {})
  }
}

module.exports = { parseCallback, handleCallback, renderScreen, PREFIX }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/menu-router.test.js`
Expected: `13 passed, 0 failed`

- [ ] **Step 5: Add to package.json and commit**

Append `&& node tests/menu-router.test.js` to test script.

```bash
git add helpers/menu/router.js tests/menu-router.test.js package.json
git commit -m "feat(menu): add callback dispatcher with parse + access + render"
```

---

## Task 10: Menu flows (force-reply chains)

**Files:**
- Create: `helpers/menu/flows.js`
- Test: `tests/menu-flows.test.js`

`startInputFlow` writes pendingInput to the group AND sends a `force_reply` prompt. `consumeInput` reads + clears pendingInput when a matching reply arrives.

- [ ] **Step 1: Write the failing test**

Create `tests/menu-flows.test.js`:

```js
const assert = require('assert')
const { startInputFlow, consumeInput } = require('../helpers/menu/flows')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const mkCtx = ({ chatId = -100, fromId = 1, group = { info: { settings: {} } } } = {}) => {
  const calls = []
  return {
    chat: { id: chatId },
    from: { id: fromId },
    group,
    telegram: {
      callApi: async (method, payload) => { calls.push({ method, payload }); return { message_id: 77 } }
    },
    _calls: calls
  }
}

test('startInputFlow sends a force_reply prompt and stores pendingInput', async () => {
  const ctx = mkCtx()
  await startInputFlow(ctx, { type: 'spam_allow', screen: 's:rules', prompt: 'Enter rule text' })

  // sent prompt
  assert.strictEqual(ctx._calls.length, 1)
  const p = ctx._calls[0].payload
  assert.strictEqual(p.text, 'Enter rule text')
  assert.deepStrictEqual(p.reply_markup, { force_reply: true, selective: true })

  // pendingInput stored
  const pi = ctx.group.info.settings.pendingInput
  assert.strictEqual(pi.userId, 1)
  assert.strictEqual(pi.type, 'spam_allow')
  assert.strictEqual(pi.screen, 's:rules')
  assert.strictEqual(pi.promptMsgId, 77)
  assert.ok(pi.expiresAt instanceof Date)
  assert.ok(pi.expiresAt.getTime() > Date.now())
})

test('startInputFlow overwrites a previous pendingInput in the same group', async () => {
  const ctx = mkCtx()
  await startInputFlow(ctx, { type: 'a', screen: 's:1', prompt: '1' })
  await startInputFlow(ctx, { type: 'b', screen: 's:2', prompt: '2' })
  assert.strictEqual(ctx.group.info.settings.pendingInput.type, 'b')
})

test('consumeInput returns matching pendingInput and clears it', () => {
  const expiresAt = new Date(Date.now() + 60_000)
  const ctx = mkCtx({
    group: {
      info: { settings: { pendingInput: { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt } } }
    }
  })
  const result = consumeInput(ctx)
  assert.deepStrictEqual(result, { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt })
  assert.strictEqual(ctx.group.info.settings.pendingInput, undefined)
})

test('consumeInput returns null when no pendingInput', () => {
  const ctx = mkCtx()
  assert.strictEqual(consumeInput(ctx), null)
})

test('consumeInput returns null when expired and clears it', () => {
  const ctx = mkCtx({
    group: {
      info: { settings: { pendingInput: { userId: 1, type: 't', screen: 's', expiresAt: new Date(Date.now() - 1) } } }
    }
  })
  assert.strictEqual(consumeInput(ctx), null)
  assert.strictEqual(ctx.group.info.settings.pendingInput, undefined)
})

test('consumeInput returns null when from.id does not match userId in pendingInput', () => {
  const ctx = mkCtx({
    fromId: 999,
    group: {
      info: { settings: { pendingInput: { userId: 1, type: 't', screen: 's', expiresAt: new Date(Date.now() + 60_000) } } }
    }
  })
  assert.strictEqual(consumeInput(ctx), null)
  // pendingInput stays — wrong user shouldn't clear someone else's prompt
  assert.ok(ctx.group.info.settings.pendingInput)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/menu-flows.test.js`
Expected: FAIL — `Cannot find module '../helpers/menu/flows'`

- [ ] **Step 3: Implement flows**

Create `helpers/menu/flows.js`:

```js
const { replyHTML } = require('../reply-html')

const INPUT_TTL_MS = 5 * 60 * 1000

const startInputFlow = async (ctx, { type, screen, prompt }) => {
  const sent = await replyHTML(ctx, prompt, {
    reply_markup: { force_reply: true, selective: true }
  })
  if (!ctx.group) ctx.group = { info: { settings: {} } }
  if (!ctx.group.info) ctx.group.info = { settings: {} }
  if (!ctx.group.info.settings) ctx.group.info.settings = {}
  ctx.group.info.settings.pendingInput = {
    userId: ctx.from.id,
    type,
    screen,
    promptMsgId: sent && sent.message_id,
    expiresAt: new Date(Date.now() + INPUT_TTL_MS)
  }
  return sent
}

const consumeInput = (ctx) => {
  const pi = ctx && ctx.group && ctx.group.info && ctx.group.info.settings && ctx.group.info.settings.pendingInput
  if (!pi || !pi.userId) return null
  if (pi.expiresAt && pi.expiresAt.getTime() < Date.now()) {
    delete ctx.group.info.settings.pendingInput
    return null
  }
  if (ctx.from && pi.userId !== ctx.from.id) return null
  delete ctx.group.info.settings.pendingInput
  return pi
}

module.exports = { startInputFlow, consumeInput, INPUT_TTL_MS }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/menu-flows.test.js`
Expected: `6 passed, 0 failed`

- [ ] **Step 5: Add to package.json and commit**

Append `&& node tests/menu-flows.test.js` to test script.

```bash
git add helpers/menu/flows.js tests/menu-flows.test.js package.json
git commit -m "feat(menu): add force-reply input flows (startInputFlow/consumeInput)"
```

---

## Task 11: pending-input middleware

**Files:**
- Create: `middlewares/pending-input.js`
- Test: `tests/pending-input.test.js`

Middleware that runs after contextLoader. If a message is a reply to the bot's force_reply prompt AND there's a matching pendingInput AND a registered handler exists, call the handler with the input text and skip downstream handlers. Otherwise, pass through.

Handlers register themselves via `registerInputHandler(type, fn)`. Plan 1 only registers the infrastructure — actual `type` handlers are added in later plans.

- [ ] **Step 1: Write the failing test**

Create `tests/pending-input.test.js`:

```js
const assert = require('assert')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const fresh = () => {
  delete require.cache[require.resolve('../middlewares/pending-input')]
  return require('../middlewares/pending-input')
}

const mkCtx = ({
  text = 'reply text',
  fromId = 1,
  pendingInput = null,
  replyToBotPromptId = null
} = {}) => ({
  message: {
    text,
    message_id: 100,
    reply_to_message: replyToBotPromptId
      ? { message_id: replyToBotPromptId, from: { id: 12345, is_bot: true } }
      : null
  },
  from: { id: fromId },
  chat: { id: -100 },
  group: { info: { settings: { pendingInput } } }
})

test('passes through when no pendingInput', async () => {
  const { pendingInputMiddleware } = fresh()
  const ctx = mkCtx({ pendingInput: null })
  let nextCalled = false
  await pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(nextCalled, true)
})

test('passes through when message is not a reply', async () => {
  const { pendingInputMiddleware } = fresh()
  const ctx = mkCtx({
    pendingInput: { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt: new Date(Date.now() + 60_000) }
  })
  let nextCalled = false
  await pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(nextCalled, true)
})

test('passes through when reply is to a different message than the prompt', async () => {
  const { pendingInputMiddleware } = fresh()
  const ctx = mkCtx({
    pendingInput: { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt: new Date(Date.now() + 60_000) },
    replyToBotPromptId: 999
  })
  let nextCalled = false
  await pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(nextCalled, true)
})

test('invokes registered handler when reply matches and from matches user', async () => {
  const mod = fresh()
  let received = null
  mod.registerInputHandler('mytype', async (ctx, input, pi) => { received = { input, pi } })
  const expiresAt = new Date(Date.now() + 60_000)
  const ctx = mkCtx({
    text: 'hello world',
    pendingInput: { userId: 1, type: 'mytype', screen: 's', promptMsgId: 7, expiresAt },
    replyToBotPromptId: 7
  })
  let nextCalled = false
  await mod.pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(nextCalled, false)
  assert.strictEqual(received.input, 'hello world')
  assert.strictEqual(received.pi.type, 'mytype')
  assert.strictEqual(ctx.group.info.settings.pendingInput, undefined)
})

test('passes through when type has no registered handler', async () => {
  const mod = fresh()
  const ctx = mkCtx({
    pendingInput: { userId: 1, type: 'unknown', screen: 's', promptMsgId: 7, expiresAt: new Date(Date.now() + 60_000) },
    replyToBotPromptId: 7
  })
  let nextCalled = false
  await mod.pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(nextCalled, true)
})

test('passes through when from.id does not match pendingInput.userId', async () => {
  const mod = fresh()
  let handlerCalled = false
  mod.registerInputHandler('t', async () => { handlerCalled = true })
  const ctx = mkCtx({
    fromId: 999,
    pendingInput: { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt: new Date(Date.now() + 60_000) },
    replyToBotPromptId: 7
  })
  let nextCalled = false
  await mod.pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(handlerCalled, false)
  assert.strictEqual(nextCalled, true)
})

test('passes through when pendingInput is expired', async () => {
  const mod = fresh()
  let handlerCalled = false
  mod.registerInputHandler('t', async () => { handlerCalled = true })
  const ctx = mkCtx({
    pendingInput: { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt: new Date(Date.now() - 1) },
    replyToBotPromptId: 7
  })
  let nextCalled = false
  await mod.pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(handlerCalled, false)
  assert.strictEqual(nextCalled, true)
})

test('handler errors do not bubble up; next is NOT called', async () => {
  const mod = fresh()
  mod.registerInputHandler('t', async () => { throw new Error('boom') })
  const ctx = mkCtx({
    pendingInput: { userId: 1, type: 't', screen: 's', promptMsgId: 7, expiresAt: new Date(Date.now() + 60_000) },
    replyToBotPromptId: 7
  })
  let nextCalled = false
  await mod.pendingInputMiddleware(ctx, async () => { nextCalled = true })
  assert.strictEqual(nextCalled, false) // handler claimed the message even on error
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/pending-input.test.js`
Expected: FAIL — `Cannot find module '../middlewares/pending-input'`

- [ ] **Step 3: Implement the middleware**

Create `middlewares/pending-input.js`:

```js
const { bot: log } = require('../helpers/logger')

const handlers = new Map()

const registerInputHandler = (type, fn) => {
  if (typeof fn !== 'function') throw new Error(`pending-input: handler for "${type}" must be a function`)
  handlers.set(type, fn)
}

const isExpired = (pi) => pi.expiresAt && pi.expiresAt.getTime() < Date.now()

const pendingInputMiddleware = async (ctx, next) => {
  if (!ctx.message || !ctx.message.text) return next()
  const pi = ctx.group && ctx.group.info && ctx.group.info.settings && ctx.group.info.settings.pendingInput
  if (!pi || !pi.userId) return next()

  const reply = ctx.message.reply_to_message
  if (!reply || !pi.promptMsgId || reply.message_id !== pi.promptMsgId) return next()

  if (!ctx.from || ctx.from.id !== pi.userId) return next()
  if (isExpired(pi)) {
    delete ctx.group.info.settings.pendingInput
    return next()
  }

  const handler = handlers.get(pi.type)
  if (!handler) return next()

  // Claim the message (clear pendingInput, do not call next)
  delete ctx.group.info.settings.pendingInput
  try {
    await handler(ctx, ctx.message.text, pi)
  } catch (err) {
    log.error({ err: err.message, type: pi.type }, 'pending-input handler error')
  }
  // Intentionally do NOT call next — the message was consumed
}

module.exports = { pendingInputMiddleware, registerInputHandler }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/pending-input.test.js`
Expected: `8 passed, 0 failed`

- [ ] **Step 5: Add to package.json and commit**

Append `&& node tests/pending-input.test.js` to test script.

```bash
git add middlewares/pending-input.js tests/pending-input.test.js package.json
git commit -m "feat(menu): add pending-input middleware for force-reply chains"
```

---

## Task 12: Menu public API barrel

**Files:**
- Create: `helpers/menu/index.js`

Single import surface for downstream plans.

- [ ] **Step 1: Create the barrel**

Create `helpers/menu/index.js`:

```js
const registry = require('./registry')
const keyboard = require('./keyboard')
const access = require('./access')
const state = require('./state')
const router = require('./router')
const flows = require('./flows')

module.exports = {
  // Registry
  registerMenu: registry.registerMenu,
  getMenu: registry.getMenu,
  listMenus: registry.listMenus,

  // Keyboard builders
  cb: keyboard.cb,
  btn: keyboard.btn,
  row: keyboard.row,
  backBtn: keyboard.backBtn,
  closeBtn: keyboard.closeBtn,
  toggleBtn: keyboard.toggleBtn,
  paginated: keyboard.paginated,
  confirmKeyboard: keyboard.confirmKeyboard,
  PREFIX: keyboard.PREFIX,
  NOOP: keyboard.NOOP,
  CLOSE: keyboard.CLOSE,

  // Access
  checkAccess: access.checkAccess,
  isAdmin: access.isAdmin,
  isInitiator: access.isInitiator,

  // State
  setState: state.setState,
  getState: state.getState,
  clearState: state.clearState,
  cleanupExpired: state.cleanupExpired,

  // Router
  parseCallback: router.parseCallback,
  handleCallback: router.handleCallback,
  renderScreen: router.renderScreen,

  // Flows
  startInputFlow: flows.startInputFlow,
  consumeInput: flows.consumeInput
}
```

- [ ] **Step 2: Verify the barrel loads**

Run: `node -e "const m = require('./helpers/menu'); console.log(Object.keys(m).length, 'exports')"`
Expected: `25 exports`

- [ ] **Step 3: Commit**

```bash
git add helpers/menu/index.js
git commit -m "feat(menu): add public API barrel"
```

---

## Task 13: Wire-up router action and middleware in bot/routes

**Files:**
- Create: `routes/menu.js`
- Modify: `routes/index.js`
- Modify: `middlewares/index.js`
- Modify: `bot.js`

Hook the new pieces into the live bot:
1. `routes/menu.js` registers `bot.action(/^m:v1:/, handleCallback)`
2. `routes/index.js` calls the new register function
3. `middlewares/index.js` exports `pendingInput`
4. `bot.js` adds `bot.use(pendingInput)` BEFORE `contextLoader` cannot work (we need group loaded first), so AFTER `contextLoader` but BEFORE `spamCheckOrchestrator` — pendingInput consumes the message early so it doesn't get treated as spam input

- [ ] **Step 1: Create routes/menu.js**

```js
const { handleCallback } = require('../helpers/menu/router')
const { PREFIX } = require('../helpers/menu/keyboard')

const registerMenuRoutes = (bot) => {
  // Match any callback whose data starts with the menu prefix.
  // Using a RegExp constructed from the literal so future PREFIX changes propagate.
  const re = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  bot.action(re, handleCallback)
}

module.exports = { registerMenuRoutes }
```

- [ ] **Step 2: Add to routes/index.js**

Modify `routes/index.js`:

```js
const { registerCommands } = require('./commands')
const { registerAdminRoutes } = require('./admin')
const { registerEvents } = require('./events')
const { registerMenuRoutes } = require('./menu')

const registerAllRoutes = (bot) => {
  registerCommands(bot)
  registerAdminRoutes(bot)
  registerMenuRoutes(bot)
  registerEvents(bot)
}

module.exports = {
  registerAllRoutes,
  registerCommands,
  registerAdminRoutes,
  registerMenuRoutes,
  registerEvents
}
```

- [ ] **Step 3: Export pendingInput from middlewares/index.js**

Modify `middlewares/index.js`:

```js
const stats = require('./stats')
const onlyGroup = require('./only-group')
const onlyAdmin = require('./only-admin')
const banDatabase = require('./ban-database')
const spamCheck = require('./spam-check')
const errorHandler = require('./error-handler')
const contextLoader = require('./context-loader')
const globalBanCheck = require('./global-ban')
const dataPersistence = require('./data-persistence')
const emojiInject = require('./emoji-inject')
const albumBuffer = require('./album-buffer')
const { pendingInputMiddleware: pendingInput } = require('./pending-input')

module.exports = {
  stats,
  onlyGroup,
  onlyAdmin,
  banDatabase,
  spamCheck,
  errorHandler,
  contextLoader,
  globalBanCheck,
  dataPersistence,
  emojiInject,
  albumBuffer,
  pendingInput
}
```

- [ ] **Step 4: Register pendingInput in bot.js**

Modify `bot.js` — find the destructured imports from `./middlewares` (around line 13-22) and add `pendingInput`:

```js
const {
  stats,
  errorHandler,
  contextLoader,
  globalBanCheck,
  banDatabase,
  spamCheck,
  dataPersistence,
  emojiInject,
  albumBuffer,
  pendingInput
} = require('./middlewares')
```

Then in `registerMiddlewares`, add `pendingInput` AFTER `contextLoader` (line 177) and BEFORE `albumBuffer`. The `albumBuffer` line is around line 183. New section:

```js
  // 8. Load context (user, group, member data)
  bot.use(contextLoader)

  // 8.25. Pending-input claim. If this message is a reply to a force_reply
  //       prompt that the menu router is waiting on, the registered
  //       handler runs and downstream middleware (album buffer, spam
  //       check, message handler) is skipped — the user just submitted
  //       form data, not a chat message.
  bot.use(pendingInput)

  // 8.5. Aggregate album (media_group_id) siblings into one ctx so that
```

- [ ] **Step 5: Smoke-verify the wiring**

Run: `node -e "const bot = require('telegraf'); const { registerAllRoutes } = require('./routes'); const Telegraf = require('telegraf'); const b = new Telegraf('FAKE'); registerAllRoutes(b); console.log('routes registered'); const m = require('./middlewares'); console.log('pendingInput exported:', typeof m.pendingInput)"`

Expected output: `routes registered\npendingInput exported: function`

- [ ] **Step 6: Run the full existing test suite to confirm no regression**

Run: `npm test`
Expected: All existing tests pass + all new tests from tasks 1–11 pass.

- [ ] **Step 7: Commit**

```bash
git add routes/menu.js routes/index.js middlewares/index.js bot.js
git commit -m "feat(menu): wire menu router action + pending-input middleware into bot"
```

---

## Task 14: Integration smoke test for full flow

**Files:**
- Create: `tests/menu-integration.test.js`

End-to-end test of: register screen → simulate callback → router parses → access passes → handler called → render edits message.

- [ ] **Step 1: Write the integration test**

Create `tests/menu-integration.test.js`:

```js
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
```

- [ ] **Step 2: Run the integration test**

Run: `node tests/menu-integration.test.js`
Expected: `4 passed, 0 failed`

- [ ] **Step 3: Add to package.json and run full suite**

Append `&& node tests/menu-integration.test.js` to test script.

Run: `npm test`
Expected: All tests pass (existing + 11 new from tasks 1–11 + integration).

- [ ] **Step 4: Commit**

```bash
git add tests/menu-integration.test.js package.json
git commit -m "test(menu): add end-to-end integration smoke test"
```

---

## Task 15: Add menu access-toast keys to all locale files

**Files:**
- Modify: `locales/uk.yaml`
- Modify: `locales/en.yaml`
- Modify: `locales/ru.yaml`
- Modify: `locales/tr.yaml`
- Modify: `locales/by.yaml`

The router emits `menu.unknown`, `menu.error`, `menu.access.only_admins`, `menu.access.only_initiator`, `menu.access.only_initiator_or_admin`, `menu.access.denied` — all referenced via `ctx.i18n.t()`. Without locale entries they would render as the raw key.

- [ ] **Step 1: Add to locales/uk.yaml**

Append at the end of `locales/uk.yaml`:

```yaml
menu:
  unknown: "Меню не знайдено"
  error: "Помилка"
  access:
    only_admins: "🔒 Тільки для адмінів групи"
    only_initiator: "🔒 Натисни команду сам"
    only_initiator_or_admin: "🔒 Тільки ініціатор або адмін групи"
    denied: "Доступ заборонено"
  saved: "✓ Збережено"
  cancelled: "↩️ Скасовано"
  session_expired: "⏱ Сесія застаріла"
```

- [ ] **Step 2: Add to locales/en.yaml**

Append:

```yaml
menu:
  unknown: "Menu not found"
  error: "Error"
  access:
    only_admins: "🔒 Group admins only"
    only_initiator: "🔒 Tap the command yourself"
    only_initiator_or_admin: "🔒 Initiator or group admin only"
    denied: "Access denied"
  saved: "✓ Saved"
  cancelled: "↩️ Cancelled"
  session_expired: "⏱ Session expired"
```

- [ ] **Step 3: Add to locales/ru.yaml**

Append:

```yaml
menu:
  unknown: "Меню не найдено"
  error: "Ошибка"
  access:
    only_admins: "🔒 Только для админов группы"
    only_initiator: "🔒 Жми команду сам"
    only_initiator_or_admin: "🔒 Только инициатор или админ группы"
    denied: "Доступ запрещён"
  saved: "✓ Сохранено"
  cancelled: "↩️ Отменено"
  session_expired: "⏱ Сессия истекла"
```

- [ ] **Step 4: Add to locales/tr.yaml**

Append:

```yaml
menu:
  unknown: "Menü bulunamadı"
  error: "Hata"
  access:
    only_admins: "🔒 Sadece grup yöneticileri"
    only_initiator: "🔒 Komuta kendin bas"
    only_initiator_or_admin: "🔒 Sadece başlatan veya grup yöneticisi"
    denied: "Erişim reddedildi"
  saved: "✓ Kaydedildi"
  cancelled: "↩️ İptal edildi"
  session_expired: "⏱ Oturum süresi doldu"
```

- [ ] **Step 5: Add to locales/by.yaml**

Append:

```yaml
menu:
  unknown: "Меню не знойдзена"
  error: "Памылка"
  access:
    only_admins: "🔒 Толькі для адмінаў групы"
    only_initiator: "🔒 Націсні каманду сам"
    only_initiator_or_admin: "🔒 Толькі ініцыятар або адмін групы"
    denied: "Доступ забаронены"
  saved: "✓ Захавана"
  cancelled: "↩️ Скасавана"
  session_expired: "⏱ Сесія састарэла"
```

- [ ] **Step 6: Verify YAML parses**

Run: `node -e "const I18n=require('telegraf-i18n'); const i=new I18n({directory:'./locales',defaultLanguage:'en'}); console.log('uk menu.unknown:', i.t('uk','menu.unknown'))"`

Expected: `uk menu.unknown: Меню не знайдено`

- [ ] **Step 7: Commit**

```bash
git add locales/uk.yaml locales/en.yaml locales/ru.yaml locales/tr.yaml locales/by.yaml
git commit -m "feat(menu): add menu.* i18n keys across all 5 locales"
```

---

## Final verification

- [ ] Run the full test suite one last time

Run: `npm test`

Expected: every test (existing + foundation) passes. If any fail, fix before declaring this plan complete.

- [ ] Run lint

Run: `npm run lint`

Expected: zero errors. If any (e.g., unused `_` vars in new files), fix.

- [ ] Verify the bot still boots (without sending real updates)

Run: `node -e "process.env.BOT_TOKEN='FAKE'; require('./bot.js'); setTimeout(() => process.exit(0), 1000)"`

Expected: no synchronous errors. Will likely log "MongoDB not connected" — that's fine, we only verify the module graph wires up.

- [ ] Final commit if anything was tweaked during verification

```bash
git status
# if dirty:
git add -A
git commit -m "chore(menu): final verification fixes"
```

---

## What this plan delivers

After all 15 tasks:

- `helpers/menu/` namespace with router, registry, keyboard builders, access guards, state helpers, force-reply flow helpers
- `helpers/cleanup-policy.js` — single source of truth for auto-delete TTLs
- `helpers/reply-html.js` — modern Bot API reply/edit wrappers
- `helpers/reactions.js` — reaction ack helpers with silent fallback
- `middlewares/pending-input.js` — wired into bot pipeline, ready for handler registration
- `routes/menu.js` — router registered, ready for screens
- `Group.settings.menuState[]` and `Group.settings.pendingInput` schema fields
- `menu.*` i18n keys in all 5 locales
- 11 test files, full coverage

Subsequent plans (commands & onboarding, mod-event unification, /settings, moderation polish, spam-vote polish, stats) build on this foundation by:
- Calling `registerMenu({...})` to add screens
- Calling `registerInputHandler('type', fn)` to handle force-reply submissions
- Calling `replyHTML`, `editHTML`, `ack`, `setReaction` to talk to Telegram
- Reading TTLs from `cleanup-policy`

No handler logic from existing files is touched in this plan — it's purely additive infrastructure.
