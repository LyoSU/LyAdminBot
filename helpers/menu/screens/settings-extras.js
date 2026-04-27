// /settings → 📝 Extras editor (§5.3 of UX design).
//
// Admin-only grid of `#name` buttons. Tap → `settings.extras.view` which
// shows the stored payload's type + preview and offers delete / rename.
//
// Contrast with the public `stats.extras` screen (helpers/menu/screens/
// stats-extras.js): that one lets ANY chat member tap an extra to have the
// bot repost the stored message. This one is the admin-only editor — no
// tap-to-send, just manage.
//
// Creation remains the legacy `!extra <name>` flow (reply-to-message). The
// "➕ Створити" button here is a toast with the instruction; wiring a
// force-reply-based creator would require handling arbitrary media replies
// and is deferred (pendingInput middleware is text-only today).

const { registerMenu, getMenu } = require('../registry')
const { cb, btn, row, backBtn, paginated } = require('../keyboard')
const { startInputFlow } = require('../flows')
const { registerInputHandler } = require('../../../middlewares/pending-input')
const { replyHTML, editHTML } = require('../../reply-html')
const { truncate } = require('../../text-utils')
const { renderEmptyState } = require('../empty-state')
const { logModEvent } = require('../../mod-log')
const { resolveTargetChatId } = require('../pm-context')
const { bot: log } = require('../../logger')

const ROOT_ID = 'settings.extras'
const VIEW_ID = 'settings.extras.view'
const PER_PAGE = 20
const COLUMNS = 2
const NAME_REGEX = /^[a-zA-Z0-9_а-яіїєґА-ЯІЇЄҐёЁ]+$/
const MAX_NAME_LEN = 30

const getExtras = (ctx) => {
  const s = ctx.group && ctx.group.info && ctx.group.info.settings
  if (!s) return []
  if (!Array.isArray(s.extras)) s.extras = []
  return s.extras
}

const maxExtra = (ctx) => {
  const s = ctx.group && ctx.group.info && ctx.group.info.settings
  return (s && s.maxExtra) || 3
}

// Slug encoded into callback_data. We store the original name in the
// settings array — slug is the routing key. Match stats-extras.js slugify
// so a round-trip name→slug stays stable.
const slugify = (name) => String(name || '')
  .toLowerCase()
  .replace(/[^a-z0-9а-яіїєґё_-]+/gi, '')
  .slice(0, 32)

// ---- settings.extras (grid) ------------------------------------------------

const buildGrid = (extras, page) => {
  const total = Math.max(1, Math.ceil(extras.length / PER_PAGE))
  const safePage = Math.max(0, Math.min(page, total - 1))
  const start = safePage * PER_PAGE
  const pageItems = extras.slice(start, start + PER_PAGE)

  const kb = []
  for (let i = 0; i < pageItems.length; i += COLUMNS) {
    const r = pageItems.slice(i, i + COLUMNS).map(ex => btn(
      `#${ex.name}`,
      cb(VIEW_ID, 'open', slugify(ex.name))
    ))
    kb.push(r)
  }

  if (total > 1) {
    const pag = paginated({
      items: Array(total * PER_PAGE), // only care about nav math
      page: safePage,
      perPage: PER_PAGE,
      screenId: ROOT_ID
    })
    if (pag.nav.length) kb.push(pag.nav)
  }
  return { kb, page: safePage, totalPages: total }
}

const renderRoot = (ctx, state = {}) => {
  const extras = getExtras(ctx)
  const max = maxExtra(ctx)
  const page = Math.max(0, parseInt(state.page, 10) || 0)

  if (extras.length === 0) {
    const empty = renderEmptyState(ctx.i18n, {
      titleKey: 'menu.settings.extras.empty_title',
      descKey: 'menu.settings.extras.empty_hint'
    })
    empty.keyboard.inline_keyboard.push(
      row(btn(ctx.i18n.t('menu.settings.extras.btn.create'), cb(ROOT_ID, 'create'))),
      row(backBtn('settings.root', { label: ctx.i18n.t('menu.settings.common.back') }))
    )
    return empty
  }

  const grid = buildGrid(extras, page)
  const text = ctx.i18n.t('menu.settings.extras.text', {
    count: extras.length,
    max
  })
  const kb = grid.kb.slice()
  kb.push(row(btn(ctx.i18n.t('menu.settings.extras.btn.create'), cb(ROOT_ID, 'create'))))
  kb.push(row(backBtn('settings.root', { label: ctx.i18n.t('menu.settings.common.back') })))
  return { text, keyboard: { inline_keyboard: kb } }
}

const registerRoot = () => registerMenu({
  id: ROOT_ID,
  access: 'group_admin',
  render: renderRoot,
  handle: async (ctx, action, args) => {
    if (action === 'page') {
      return { render: true, state: { page: parseInt(args[0], 10) || 0 } }
    }
    if (action === 'create') {
      // Creating extras requires snapshotting a replied-to message — not
      // feasible via force-reply in a DM context. Surface the instruction
      // toast and let the admin use the legacy `!extra` flow in-group.
      return { render: false, toast: 'menu.empty_state.extras.cue_toast' }
    }
    return { render: false }
  }
})

// ---- settings.extras.view -------------------------------------------------

// Describe the extra payload type in a locale-friendly way. Types are
// telegraf-replicators copyMethods keys (e.g. `text`, `photo`, `animation`).
const describeType = (ctx, extra) => {
  const type = (extra && extra.type) || 'unknown'
  const key = `menu.settings.extras.type.${type}`
  const resolved = ctx.i18n.t(key)
  if (resolved && resolved !== key) return resolved
  return type
}

const extractPreview = (extra) => {
  const msg = (extra && extra.message) || {}
  const raw = msg.text || msg.caption || ''
  return raw ? truncate(String(raw).replace(/\n/g, ' '), 120) : ''
}

const findExtraBySlug = (ctx, slug) => {
  const extras = getExtras(ctx)
  return extras.find(e => slugify(e.name) === slug) || null
}

const renderView = (ctx, state = {}) => {
  // Slug comes in via state for open/navigation, set by handle() below.
  const slug = state.slug
  const extra = slug ? findExtraBySlug(ctx, slug) : null
  if (!extra) {
    // Navigate back to the grid on stale slug.
    const root = getMenu(ROOT_ID)
    if (root) return root.render(ctx, {})
    return {
      text: ctx.i18n.t('menu.settings.extras.not_found'),
      keyboard: {
        inline_keyboard: [row(backBtn(ROOT_ID, { label: ctx.i18n.t('menu.settings.common.back') }))]
      }
    }
  }

  const text = ctx.i18n.t('menu.settings.extras.view.text', {
    name: extra.name,
    type: describeType(ctx, extra),
    preview: extractPreview(extra) || ctx.i18n.t('menu.settings.extras.view.no_preview')
  })
  const keyboard = {
    inline_keyboard: [
      row(
        btn(ctx.i18n.t('menu.settings.extras.view.btn.rename'), cb(VIEW_ID, 'rename', slug)),
        btn(ctx.i18n.t('menu.settings.extras.view.btn.delete'), cb(VIEW_ID, 'delete', slug))
      ),
      row(backBtn(ROOT_ID, { label: ctx.i18n.t('menu.settings.common.back') }))
    ]
  }
  return { text, keyboard }
}

const renderConfirmDelete = (ctx, state = {}) => {
  const extra = findExtraBySlug(ctx, state.slug)
  if (!extra) {
    const root = getMenu(ROOT_ID)
    if (root) return root.render(ctx, {})
    return { text: ctx.i18n.t('menu.settings.extras.not_found'), keyboard: { inline_keyboard: [] } }
  }
  const text = ctx.i18n.t('menu.settings.extras.view.confirm_delete', { name: extra.name })
  const keyboard = {
    inline_keyboard: [
      row(
        btn(ctx.i18n.t('menu.settings.extras.view.btn.confirm'), cb(VIEW_ID, 'del_ok', state.slug)),
        btn(ctx.i18n.t('menu.settings.common.back'), cb(VIEW_ID, 'open', state.slug))
      )
    ]
  }
  return { text, keyboard }
}

const registerView = () => registerMenu({
  id: VIEW_ID,
  access: 'group_admin',
  render: (ctx, state) => {
    if (state && state.confirm === 'delete') return renderConfirmDelete(ctx, state)
    return renderView(ctx, state)
  },
  handle: async (ctx, action, args) => {
    const slug = args && args[0]
    if (!slug) return { render: false }
    const extras = getExtras(ctx)
    const idx = extras.findIndex(e => slugify(e.name) === slug)
    if (idx < 0) return { render: false, toast: 'menu.settings.extras.not_found' }

    if (action === 'delete') {
      return { render: true, state: { slug, confirm: 'delete' } }
    }

    if (action === 'del_ok') {
      const removed = extras[idx]
      extras.splice(idx, 1)
      // Mongoose array splice path: sometimes Mongoose needs explicit markModified,
      // but the array is a plain Mongoose subdoc array (DocumentArray) so splice
      // is tracked natively.
      logModEvent(ctx.db, {
        chatId: resolveTargetChatId(ctx),
        eventType: 'settings_change',
        actor: ctx.from,
        action: `extras.delete ${removed.name}`
      }).catch(() => {})
      // After delete, route back to the grid.
      const root = getMenu(ROOT_ID)
      if (root) {
        try {
          const view = await root.render(ctx, {})
          await editHTML(ctx, ctx.callbackQuery.message.message_id, view.text, {
            reply_markup: view.keyboard
          })
        } catch (err) {
          if (!/message is not modified/.test(err.message || '')) {
            log.debug({ err }, 'settings.extras: grid re-render failed')
          }
        }
      }
      return { render: false, toast: 'menu.settings.extras.view.deleted' }
    }

    if (action === 'rename') {
      await startInputFlow(ctx, {
        type: 'settings.extras.rename',
        screen: VIEW_ID,
        prompt: ctx.i18n.t('menu.settings.extras.view.rename_prompt', {
          name: extras[idx].name
        })
      })
      // Stash the current slug so the rename handler knows which extra to edit.
      if (!ctx.group.info.settings.pendingInput) ctx.group.info.settings.pendingInput = {}
      ctx.group.info.settings.pendingInput.data = { slug }
      return { render: false, silent: true }
    }

    if (action === 'open') {
      return { render: true, state: { slug } }
    }
    return { render: false }
  }
})

const handleRenameInput = async (ctx, text, pi) => {
  const trimmed = (text || '').trim()
  if (!trimmed || trimmed === '/cancel') {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.extras.view.cancelled'))
    return
  }
  if (trimmed.length > MAX_NAME_LEN) {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.extras.view.rename_too_long'))
    return
  }
  if (!NAME_REGEX.test(trimmed)) {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.extras.view.rename_invalid'))
    return
  }
  const extras = getExtras(ctx)
  const currentSlug = pi && pi.data && pi.data.slug
  const idx = extras.findIndex(e => slugify(e.name) === currentSlug)
  if (idx < 0) {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.extras.not_found'))
    return
  }
  // Uniqueness check (case-insensitive, excluding self).
  const conflict = extras.some((e, i) =>
    i !== idx && e.name.toLowerCase() === trimmed.toLowerCase()
  )
  if (conflict) {
    await replyHTML(ctx, ctx.i18n.t('menu.settings.extras.view.rename_exists'))
    return
  }
  const oldName = extras[idx].name
  extras[idx].name = trimmed
  logModEvent(ctx.db, {
    chatId: resolveTargetChatId(ctx),
    eventType: 'settings_change',
    actor: ctx.from,
    action: `extras.rename ${oldName} → ${trimmed}`
  }).catch(() => {})
  await replyHTML(ctx, ctx.i18n.t('menu.settings.extras.view.renamed', {
    from: oldName,
    to: trimmed
  }))
}

// ---- Boot ------------------------------------------------------------------

let inputHandlersRegistered = false
const registerInputHandlers = () => {
  if (inputHandlersRegistered) return
  inputHandlersRegistered = true
  try {
    registerInputHandler('settings.extras.rename', handleRenameInput)
  } catch (err) {
    log.debug({ err }, 'settings-extras: registerInputHandler skipped')
  }
}

const register = () => {
  registerRoot()
  registerView()
  registerInputHandlers()
}

module.exports = {
  register,
  SCREEN_IDS: { root: ROOT_ID, view: VIEW_ID },
  PER_PAGE,
  COLUMNS,
  NAME_REGEX,
  MAX_NAME_LEN,
  slugify,
  buildGrid,
  renderRoot,
  renderView,
  handleRenameInput,
  describeType,
  extractPreview
}
