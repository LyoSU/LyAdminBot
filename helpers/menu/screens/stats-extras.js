// /extras grid screen (§13 of UX spec).
//
// Two-column grid of inline buttons (one per stored extra). Tap → the bot
// sends that extra's stored message into the chat (reuses the standard
// send path via telegraf-replicators). Pagination kicks in above 10 items.
//
// Callback shape:
//   m:v1:stats.extras:tap:<slug>         — send the named extra
//   m:v1:stats.extras:page:<N>           — pagination
//   m:v1:stats.extras:cta                — empty-state CTA (toast only)
//
// Admin-side edit/delete buttons are intentionally deferred to Plan 5's
// /settings → Extras subscreen — this screen is the public "tap to send"
// view, not an admin editor.

const replicators = require('telegraf/core/replicators')
const { registerMenu } = require('../registry')
const { cb, btn, row, paginated, closeBtn } = require('../keyboard')
const { renderEmptyState } = require('../empty-state')
const { bot: log } = require('../../logger')

const SCREEN_ID = 'stats.extras'
const PER_PAGE = 10
const COLUMNS = 2

/**
 * Build a slug → original-name map for callback round-trips. Slugs are the
 * extra's name with non-url-safe chars stripped (names are typically ASCII
 * hashtags already; we keep them short to respect the 64-byte callback
 * limit enforced by cb()).
 */
const slugify = (name) => String(name || '')
  .toLowerCase()
  .replace(/[^a-z0-9а-яіїєґё_-]+/gi, '')
  .slice(0, 32)

/**
 * Render keyboard only (no text body other than title) — the grid itself
 * is the whole UI. Accepts a pre-sliced array of { name } extras.
 */
function buildGrid ({ extras, page = 0, screenId = SCREEN_ID }) {
  const total = Math.max(1, Math.ceil(extras.length / PER_PAGE))
  const safePage = Math.max(0, Math.min(page, total - 1))
  const pageItems = extras.slice(safePage * PER_PAGE, safePage * PER_PAGE + PER_PAGE)

  const kb = []
  // 2-wide grid — pair up items per row.
  for (let i = 0; i < pageItems.length; i += COLUMNS) {
    const rowBtns = pageItems.slice(i, i + COLUMNS).map(ex => btn(
      `#${ex.name}`,
      cb(screenId, 'tap', slugify(ex.name))
    ))
    kb.push(rowBtns)
  }

  if (total > 1) {
    const pag = paginated({
      items: Array(total * PER_PAGE),
      page: safePage,
      perPage: PER_PAGE,
      screenId
    })
    if (pag.nav.length) kb.push(pag.nav)
  }

  kb.push(row(closeBtn()))
  return { inline_keyboard: kb, totalPages: total, page: safePage }
}

async function render (ctx, state) {
  const page = Math.max(0, parseInt(state && state.page, 10) || 0)
  const extras = (ctx.group && ctx.group.info && ctx.group.info.settings && ctx.group.info.settings.extras) || []

  if (extras.length === 0) {
    const empty = renderEmptyState(ctx.i18n, {
      titleKey: 'menu.empty_state.extras.title',
      descKey: 'menu.empty_state.extras.hint',
      ctas: [{
        label: ctx.i18n.t('menu.empty_state.extras.btn_create'),
        callback: cb(SCREEN_ID, 'cta')
      }]
    })
    empty.keyboard.inline_keyboard.push([closeBtn()])
    return empty
  }

  const max = (ctx.group.info.settings.maxExtra) || 50
  const grid = buildGrid({ extras, page, screenId: SCREEN_ID })
  const title = ctx.i18n.t('menu.stats.extras.title', {
    count: extras.length,
    max
  })

  return { text: title, keyboard: { inline_keyboard: grid.inline_keyboard } }
}

/**
 * Send the referenced extra into the same chat. Reuses telegraf's copyMethods
 * replicators — same surface as handlers/extra.js.
 */
async function sendExtra (ctx, slug) {
  const extras = (ctx.group && ctx.group.info && ctx.group.info.settings && ctx.group.info.settings.extras) || []
  const match = extras.find(e => slugify(e.name) === slug)
  if (!match) return false
  try {
    const method = replicators.copyMethods[match.type]
    if (!method) return false
    const opts = Object.assign({ chat_id: ctx.chat.id }, match.message)
    delete opts.reply_to_message_id
    await ctx.telegram.callApi(method, opts)
    return true
  } catch (err) {
    log.debug({ err: err.message, slug }, 'stats.extras: send failed')
    return false
  }
}

async function handle (ctx, action, args) {
  if (action === 'page') {
    return { render: true, state: { page: parseInt(args[0], 10) || 0 } }
  }
  if (action === 'tap') {
    const slug = args[0]
    const ok = await sendExtra(ctx, slug)
    if (!ok) {
      return { render: false, silent: true }
    }
    return { render: false, silent: true }
  }
  if (action === 'cta') {
    // Empty-state CTA — we can't force-reply here because the user might
    // not be an admin. Show an instruction toast and leave it at that.
    return { render: false, toast: 'menu.empty_state.extras.cue_toast' }
  }
  return null
}

const register = () => {
  registerMenu({
    id: SCREEN_ID,
    access: 'public',
    render,
    handle
  })
}

module.exports = {
  register,
  SCREEN_ID,
  PER_PAGE,
  COLUMNS,
  slugify,
  buildGrid,
  sendExtra,
  render,
  handle
}
