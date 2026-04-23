// /top_banan leaderboard screen (§12 of UX spec).
//
// Same shape as stats-top.js but the value column renders humanized ban
// duration. Sorted by total ban-time (sum of seconds); the legacy variant
// that also printed a second list by ban-count is dropped — if users ask
// for it we can add a toggle, but it duplicated content and made the UX
// noisier than the spec intends.

const humanizeDuration = require('humanize-duration')
const { registerMenu } = require('../registry')
const { closeBtn } = require('../keyboard')
const { userName } = require('../../../utils')
const { renderEmptyState } = require('../empty-state')
const { bot: log } = require('../../logger')
const {
  PER_PAGE,
  MEDALS,
  NBSP,
  padRank,
  renderPage,
  buildKeyboard
} = require('./stats-top')

const SCREEN_ID = 'stats.top_banan'

const humanizeBan = (seconds, locale) => humanizeDuration(
  (seconds || 0) * 1000,
  { language: locale, fallbacks: ['en'], largest: 2, round: true }
)

/**
 * Fetch + sort members by total banan time. Returns an array of
 * render-ready { id, name, value } rows.
 */
async function fetchTopBanan (ctx) {
  if (!ctx.db || !ctx.group || !ctx.group.info) return []
  const members = await ctx.db.GroupMember.find({ group: ctx.group.info })
  const rows = []
  for (const m of members) {
    if (!m.banan || (!m.banan.num && !m.banan.sum)) continue
    rows.push({ telegram_id: m.telegram_id, banan: m.banan })
  }
  rows.sort((a, b) => (b.banan.sum || 0) - (a.banan.sum || 0))

  const top = rows.slice(0, PER_PAGE * 5)
  const locale = ctx.i18n.locale()
  const result = []
  for (const r of top) {
    const user = await ctx.db.User.findOne({ telegram_id: r.telegram_id }).catch(() => null)
    if (!user) continue
    result.push({
      id: r.telegram_id,
      name: userName(user, true),
      value: humanizeBan(r.banan.sum || 0, locale),
      count: r.banan.num || 0
    })
  }
  return result
}

async function render (ctx, state) {
  const page = Math.max(0, parseInt(state && state.page, 10) || 0)
  const chatName = (ctx.chat && ctx.chat.title) || ''

  let rows = []
  try {
    rows = await fetchTopBanan(ctx)
  } catch (err) {
    log.debug({ err: err.message }, 'stats.top_banan: fetch failed')
  }

  if (rows.length === 0) {
    const empty = renderEmptyState(ctx.i18n, {
      titleKey: 'menu.empty_state.top_banan.title',
      descKey: 'menu.empty_state.top_banan.hint'
    })
    empty.keyboard.inline_keyboard.push([closeBtn()])
    return empty
  }

  const view = renderPage({
    rows,
    page,
    chatName,
    i18n: ctx.i18n,
    titleKey: 'menu.stats.top_banan.title',
    itemKey: 'menu.stats.top_banan.item'
  })
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
  humanizeBan,
  fetchTopBanan,
  render,
  handle
}
