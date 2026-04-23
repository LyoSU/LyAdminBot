// /settings → 👋 Welcome editor (§5.2 of UX design).
//
// Three screens:
//   settings.welcome       — root: toggle + counts + navigation.
//   settings.welcome.texts — paginated text list, add/remove.
//   settings.welcome.gifs  — paginated gif list, add/remove.
//
// PM-only: reached via the settings.root panel, which is itself entered
// through the `/start settings_<chatId>` deep-link. No new in-group entry
// commands (admin panels must not render in groups — see handlers/settings.js).
//
// Data store: `ctx.group.info.settings.welcome` (already in group.js schema).
// Persistence runs via the standard pendingInput / dataPersistence path.
//
// %name% policy (spec clarification): the legacy `!text` command REQUIRES
// `%name%` in welcome text. Here we ALLOW but do not require it — makes the
// force-reply less error-prone for admins who want a generic "Welcome!" line
// and still leaves the legacy strict-mode in place for backward compat.

const { registerMenu } = require('../registry')
const { cb, btn, row, backBtn, paginated } = require('../keyboard')
const { startInputFlow } = require('../flows')
const { registerInputHandler } = require('../../../middlewares/pending-input')
const { replyHTML } = require('../../reply-html')
const { truncate } = require('../../text-utils')
const { renderEmptyState } = require('../empty-state')
const { logModEvent } = require('../../mod-log')
const { resolveTargetChatId } = require('../pm-context')
const { bot: log } = require('../../logger')

const ROOT_ID = 'settings.welcome'
const TEXTS_ID = 'settings.welcome.texts'
const GIFS_ID = 'settings.welcome.gifs'

const TEXTS_PER_PAGE = 5
const GIFS_PER_PAGE = 8
const MAX_TEXTS = 20
const MAX_GIFS = 20
const MAX_TEXT_LEN = 1000

// Ensure the welcome sub-tree exists — legacy groups may predate these fields.
const ensureWelcome = (ctx) => {
  const s = ctx.group && ctx.group.info && ctx.group.info.settings
  if (!s) return null
  if (!s.welcome) s.welcome = { enable: false, gifs: [], texts: [] }
  if (!Array.isArray(s.welcome.texts)) s.welcome.texts = []
  if (!Array.isArray(s.welcome.gifs)) s.welcome.gifs = []
  return s.welcome
}

const onOff = (ctx, value) => ctx.i18n.t(value
  ? 'menu.settings.common.on'
  : 'menu.settings.common.off')

// ---- settings.welcome (root) ----------------------------------------------

const renderRoot = (ctx) => {
  const w = ensureWelcome(ctx) || { enable: false, texts: [], gifs: [] }
  const text = ctx.i18n.t('menu.settings.welcome.text', {
    state: onOff(ctx, w.enable === true),
    textsCount: w.texts.length,
    gifsCount: w.gifs.length
  })
  const toggleKey = w.enable
    ? 'menu.settings.welcome.btn.disable'
    : 'menu.settings.welcome.btn.enable'
  const keyboard = {
    inline_keyboard: [
      row(btn(ctx.i18n.t(toggleKey), cb(ROOT_ID, 'toggle'))),
      row(
        btn(ctx.i18n.t('menu.settings.welcome.btn.texts'), cb(TEXTS_ID, 'open')),
        btn(ctx.i18n.t('menu.settings.welcome.btn.gifs'), cb(GIFS_ID, 'open'))
      ),
      row(backBtn('settings.root', { label: ctx.i18n.t('menu.settings.common.back') }))
    ]
  }
  return { text, keyboard }
}

const registerRoot = () => registerMenu({
  id: ROOT_ID,
  access: 'group_admin',
  render: renderRoot,
  handle: async (ctx, action) => {
    if (action === 'toggle') {
      const w = ensureWelcome(ctx)
      if (!w) return { render: false }
      const next = !(w.enable === true)
      w.enable = next
      // Audit: record the toggle in ModLog for the journal.
      logModEvent(ctx.db, {
        chatId: resolveTargetChatId(ctx),
        eventType: 'settings_change',
        actor: ctx.from,
        action: `welcome.enable → ${next}`
      }).catch(() => {})
      return 'render'
    }
    return { render: false }
  }
})

// ---- settings.welcome.texts -----------------------------------------------

const renderTexts = (ctx, state = {}) => {
  const w = ensureWelcome(ctx) || { texts: [] }
  const items = w.texts.map((t, idx) => ({ t, idx }))
  const page = Math.max(0, parseInt(state.page, 10) || 0)

  if (items.length === 0) {
    const empty = renderEmptyState(ctx.i18n, {
      titleKey: 'menu.settings.welcome.texts.empty_title',
      descKey: 'menu.settings.welcome.texts.empty_hint'
    })
    empty.keyboard.inline_keyboard.push(
      row(btn(ctx.i18n.t('menu.settings.welcome.texts.btn.add_first'), cb(TEXTS_ID, 'add'))),
      row(backBtn(ROOT_ID, { label: ctx.i18n.t('menu.settings.common.back') }))
    )
    return empty
  }

  const pag = paginated({ items, page, perPage: TEXTS_PER_PAGE, screenId: TEXTS_ID })
  const listLines = pag.pageItems.map(({ t, idx }) =>
    ctx.i18n.t('menu.settings.welcome.texts.item', {
      index: idx + 1,
      preview: truncate(String(t || '').replace(/\n/g, ' '), 50)
    })
  ).join('\n')

  const text = ctx.i18n.t('menu.settings.welcome.texts.text', {
    total: items.length,
    max: MAX_TEXTS,
    list: listLines
  })

  const kb = []
  // Delete buttons, one per visible row (chunked 5 per row).
  const delBtns = pag.pageItems.map(({ idx }) => btn(
    `${idx + 1} 🗑`,
    cb(TEXTS_ID, 'del', String(idx))
  ))
  for (let i = 0; i < delBtns.length; i += 5) kb.push(delBtns.slice(i, i + 5))
  if (pag.nav.length) kb.push(pag.nav)
  kb.push(row(btn(ctx.i18n.t('menu.settings.welcome.texts.btn.add'), cb(TEXTS_ID, 'add'))))
  kb.push(row(backBtn(ROOT_ID, { label: ctx.i18n.t('menu.settings.common.back') })))
  return { text, keyboard: { inline_keyboard: kb } }
}

const registerTexts = () => registerMenu({
  id: TEXTS_ID,
  access: 'group_admin',
  render: renderTexts,
  handle: async (ctx, action, args) => {
    const w = ensureWelcome(ctx)
    if (!w) return { render: false }
    if (action === 'page') {
      return { render: true, state: { page: parseInt(args[0], 10) || 0 } }
    }
    if (action === 'del') {
      const idx = parseInt(args[0], 10)
      if (Number.isFinite(idx) && idx >= 0 && idx < w.texts.length) {
        w.texts.splice(idx, 1)
        return { render: true, toast: 'menu.settings.welcome.texts.removed' }
      }
      return { render: false }
    }
    if (action === 'add') {
      if (w.texts.length >= MAX_TEXTS) {
        return { render: false, toast: 'menu.settings.welcome.texts.limit' }
      }
      await startInputFlow(ctx, {
        type: 'settings.welcome.text.add',
        screen: TEXTS_ID,
        prompt: ctx.i18n.t('menu.settings.welcome.texts.prompt')
      })
      return { render: false, silent: true }
    }
    return { render: false }
  }
})

// Block <a href=...> tags: welcome messages are sent by the bot and we don't
// want the bot lending its credibility to phishing URLs. Admins who want to
// link something can post it manually or use %name% for mentions. Other
// Telegram-safe HTML (b/i/code/etc.) passes through.
const LINK_TAG_RE = /<\s*a\b[^>]*>/i

const handleTextInput = async (ctx, text) => {
  const trimmed = (text || '').trim()
  if (!trimmed || trimmed === '/cancel') {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.welcome.texts.cancelled'))
    return
  }
  if (trimmed.length > MAX_TEXT_LEN) {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.welcome.texts.too_long'))
    return
  }
  if (LINK_TAG_RE.test(trimmed)) {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.welcome.texts.links_not_allowed'))
    return
  }
  const w = ensureWelcome(ctx)
  if (!w) return
  if (w.texts.length >= MAX_TEXTS) {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.welcome.texts.limit'))
    return
  }
  w.texts.push(trimmed)
  await replyHTML(ctx, ctx.i18n.t('menu.settings.welcome.texts.added'))
}

// ---- settings.welcome.gifs -------------------------------------------------

const renderGifs = (ctx, state = {}) => {
  const w = ensureWelcome(ctx) || { gifs: [] }
  const items = w.gifs.map((id, idx) => ({ id, idx }))
  const page = Math.max(0, parseInt(state.page, 10) || 0)

  if (items.length === 0) {
    const empty = renderEmptyState(ctx.i18n, {
      titleKey: 'menu.settings.welcome.gifs.empty_title',
      descKey: 'menu.settings.welcome.gifs.empty_hint'
    })
    empty.keyboard.inline_keyboard.push(
      row(btn(ctx.i18n.t('menu.settings.welcome.gifs.btn.add_first'), cb(GIFS_ID, 'add'))),
      row(backBtn(ROOT_ID, { label: ctx.i18n.t('menu.settings.common.back') }))
    )
    return empty
  }

  const pag = paginated({ items, page, perPage: GIFS_PER_PAGE, screenId: GIFS_ID })
  // For gifs we can't preview the file inside the text block — Telegram
  // inline-keyboard text can't include media. Show `#N` rows instead.
  const listLines = pag.pageItems.map(({ idx }) =>
    ctx.i18n.t('menu.settings.welcome.gifs.item', { index: idx + 1 })
  ).join('\n')
  const text = ctx.i18n.t('menu.settings.welcome.gifs.text', {
    total: items.length,
    max: MAX_GIFS,
    list: listLines
  })

  const kb = []
  const delBtns = pag.pageItems.map(({ idx }) => btn(
    `${idx + 1} 🗑`,
    cb(GIFS_ID, 'del', String(idx))
  ))
  for (let i = 0; i < delBtns.length; i += 5) kb.push(delBtns.slice(i, i + 5))
  if (pag.nav.length) kb.push(pag.nav)
  kb.push(row(btn(ctx.i18n.t('menu.settings.welcome.gifs.btn.add'), cb(GIFS_ID, 'add'))))
  kb.push(row(backBtn(ROOT_ID, { label: ctx.i18n.t('menu.settings.common.back') })))
  return { text, keyboard: { inline_keyboard: kb } }
}

const registerGifs = () => registerMenu({
  id: GIFS_ID,
  access: 'group_admin',
  render: renderGifs,
  handle: async (ctx, action, args) => {
    const w = ensureWelcome(ctx)
    if (!w) return { render: false }
    if (action === 'page') {
      return { render: true, state: { page: parseInt(args[0], 10) || 0 } }
    }
    if (action === 'del') {
      const idx = parseInt(args[0], 10)
      if (Number.isFinite(idx) && idx >= 0 && idx < w.gifs.length) {
        w.gifs.splice(idx, 1)
        return { render: true, toast: 'menu.settings.welcome.gifs.removed' }
      }
      return { render: false }
    }
    if (action === 'add') {
      if (w.gifs.length >= MAX_GIFS) {
        return { render: false, toast: 'menu.settings.welcome.gifs.limit' }
      }
      await startInputFlow(ctx, {
        type: 'settings.welcome.gif.add',
        screen: GIFS_ID,
        prompt: ctx.i18n.t('menu.settings.welcome.gifs.prompt')
      })
      return { render: false, silent: true }
    }
    return { render: false }
  }
})

// The gif input handler accepts a replied media message (animation, sticker,
// video, or document — we save its file_id) OR a pasted file_id fallback.
// pendingInput now surfaces media via the 4th arg `input` (kind/fileId).
const GIF_MEDIA_KINDS = new Set(['animation', 'sticker', 'video', 'document'])

const handleGifInput = async (ctx, text, _pi, input) => {
  const trimmed = (text || '').trim()
  if (trimmed === '/cancel') {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.welcome.gifs.cancelled'))
    return
  }

  let fileId = null
  if (input && input.fileId && GIF_MEDIA_KINDS.has(input.kind)) {
    fileId = input.fileId
  } else if (trimmed && /^[\w-]{20,}$/.test(trimmed)) {
    // Fallback: pasted file_id string. Telegram file_ids are long alnum/-/_
    fileId = trimmed
  } else {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.welcome.gifs.invalid'))
    return
  }

  const w = ensureWelcome(ctx)
  if (!w) return
  if (w.gifs.length >= MAX_GIFS) {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.welcome.gifs.limit'))
    return
  }
  if (w.gifs.includes(fileId)) {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.welcome.gifs.duplicate'))
    return
  }
  w.gifs.push(fileId)
  await replyHTML(ctx, ctx.i18n.t('menu.settings.welcome.gifs.added'))
}

// ---- Boot ------------------------------------------------------------------

let inputHandlersRegistered = false
const registerInputHandlers = () => {
  if (inputHandlersRegistered) return
  inputHandlersRegistered = true
  try {
    registerInputHandler('settings.welcome.text.add', handleTextInput)
    registerInputHandler('settings.welcome.gif.add', handleGifInput)
  } catch (err) {
    log.debug({ err: err.message }, 'settings-welcome: registerInputHandler skipped (likely duplicate)')
  }
}

const register = () => {
  registerRoot()
  registerTexts()
  registerGifs()
  registerInputHandlers()
}

module.exports = {
  register,
  SCREEN_IDS: {
    root: ROOT_ID,
    texts: TEXTS_ID,
    gifs: GIFS_ID
  },
  // Exposed for tests.
  MAX_TEXTS,
  MAX_GIFS,
  MAX_TEXT_LEN,
  TEXTS_PER_PAGE,
  GIFS_PER_PAGE,
  renderRoot,
  renderTexts,
  renderGifs,
  handleTextInput,
  handleGifInput
}
