// /top leaderboard screen (§12 of UX spec).
//
// Pagination: 10 per page. Ranks rendered with NBSP-alignment so 1–10 stay
// right-aligned in a monospace-y visual (the leading space makes 1-digit
// ranks pad to match 2-digit ones). Medals 👑/🥈/🥉 only on page 1.
//
// Period toggle [🕒 7 днів] [📅 Весь час] is intentionally NOT rendered:
// database/models/groupMember.js has no per-period stats timestamps, so
// "7 days" and "all time" would return identical lists. The toggle stays
// a TODO for a future schema migration (see Plan 8 final report).
//
// Access `public` — every group member can view the same list. Any click
// on pagination is accepted (stateless pagination); the render function
// re-fetches and re-slices on each call.

const { registerMenu } = require('../registry')
const { row, paginated, closeBtn } = require('../keyboard')
const { userName } = require('../../../utils')
const { renderEmptyState } = require('../empty-state')
const { bot: log } = require('../../logger')

const SCREEN_ID = 'stats.top'
const PER_PAGE = 10
const NBSP = ' '

// Medal glyphs — only page 1 gets a medal column to avoid visual noise on
// deeper pages. Using plain strings so the constants are easy to test.
const MEDALS = ['👑', '🥈', '🥉']

/**
 * Right-pad a rank number with NBSPs so ranks stay aligned up to two digits:
 *   1 →  " 1" (NBSP + "1"),  10 → "10". Not grapheme-perfect but good enough
 *   for Latin/Cyrillic typography.
 */
const padRank = (n) => {
  const s = String(n)
  return s.length >= 2 ? s : NBSP + s
}

/**
 * Pure renderer for a page of the top list.
 *
 * @param {object} p
 * @param {Array<{id:number,name:string,value:number|string}>} p.rows
 *   Sorted descending by `value`. `value` is the display string (e.g.
 *   "2 341" or "1.2%"); caller formats.
 * @param {number} p.page - 0-based page index.
 * @param {string} p.chatName
 * @param {object} p.i18n - Telegraf-i18n instance (t()).
 * @param {string} [p.titleKey='menu.stats.top.title']
 * @param {string} [p.itemKey='menu.stats.top.item']
 * @returns {{ text:string, totalPages:number, pageItems:Array }}
 */
function renderPage ({ rows, page = 0, chatName, i18n, titleKey, itemKey }) {
  const total = Math.max(1, Math.ceil(rows.length / PER_PAGE))
  const safePage = Math.max(0, Math.min(page, total - 1))
  const pageItems = rows.slice(safePage * PER_PAGE, safePage * PER_PAGE + PER_PAGE)

  const lines = []
  lines.push(i18n.t(titleKey || 'menu.stats.top.title', {
    chatName: chatName || '',
    page: safePage + 1,
    total
  }))
  lines.push('')
  for (let i = 0; i < pageItems.length; i++) {
    const absoluteRank = safePage * PER_PAGE + i + 1
    const medal = safePage === 0 && i < MEDALS.length ? `${MEDALS[i]} ` : ''
    lines.push(i18n.t(itemKey || 'menu.stats.top.item', {
      rank: padRank(absoluteRank) + '.',
      medal,
      name: pageItems[i].name,
      value: pageItems[i].value
    }))
  }

  return { text: lines.join('\n'), totalPages: total, pageItems, page: safePage }
}

/**
 * Build the inline-keyboard for a given page. Period toggle is intentionally
 * omitted — see file header.
 */
function buildKeyboard ({ page, totalPages, screenId }) {
  const kb = []
  if (totalPages > 1) {
    const pag = paginated({ items: Array(totalPages * PER_PAGE), page, perPage: PER_PAGE, screenId })
    if (pag.nav.length) kb.push(pag.nav)
  }
  kb.push(row(closeBtn()))
  return { inline_keyboard: kb }
}

/**
 * Fetch sorted rows for the "active" leaderboard (text contribution %).
 * Returns a plain array; caller decides page/render.
 */
async function fetchTopActive (ctx) {
  if (!ctx.db || !ctx.group || !ctx.group.info) return []
  const members = await ctx.db.GroupMember.find({ group: ctx.group.info })
  const totalText = (ctx.group.info.stats && ctx.group.info.stats.textTotal) || 0
  const rows = []
  for (const m of members) {
    const pct = totalText > 0 ? ((m.stats.textTotal || 0) * 100) / totalText : 0
    if (pct <= 0) continue
    rows.push({ telegram_id: m.telegram_id, pct })
  }
  rows.sort((a, b) => b.pct - a.pct)

  // Resolve user names (cheapest batch: sequential findOne — same as legacy).
  // Keep the top ~50 so pagination has material to work with.
  const top = rows.slice(0, PER_PAGE * 5)
  const result = []
  for (const r of top) {
    const user = await ctx.db.User.findOne({ telegram_id: r.telegram_id }).catch(() => null)
    if (!user) continue
    result.push({
      id: r.telegram_id,
      name: userName(user, true),
      // Display format: "72.13%". Caller translates rank/medal.
      value: `${r.pct.toFixed(2)}%`
    })
  }
  return result
}

async function render (ctx, state) {
  const page = Math.max(0, parseInt(state && state.page, 10) || 0)
  const chatName = (ctx.chat && ctx.chat.title) || ''

  let rows = []
  try {
    rows = await fetchTopActive(ctx)
  } catch (err) {
    log.debug({ err: err.message }, 'stats.top: fetch failed')
  }

  if (rows.length === 0) {
    const empty = renderEmptyState(ctx.i18n, {
      titleKey: 'menu.empty_state.top.title',
      descKey: 'menu.empty_state.top.hint'
    })
    empty.keyboard.inline_keyboard.push([closeBtn()])
    return empty
  }

  const view = renderPage({ rows, page, chatName, i18n: ctx.i18n })
  const keyboard = buildKeyboard({
    page: view.page,
    totalPages: view.totalPages,
    screenId: SCREEN_ID
  })
  return { text: view.text, keyboard }
}

async function handle (ctx, action, args) {
  if (action === 'page') {
    const nextPage = parseInt(args[0], 10) || 0
    return { render: true, state: { page: nextPage } }
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
  MEDALS,
  NBSP,
  padRank,
  renderPage,
  buildKeyboard,
  fetchTopActive,
  render,
  handle
}
