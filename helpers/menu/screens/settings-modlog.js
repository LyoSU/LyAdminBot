// /settings → 📋 Журнал (§5.6 of UX design).
//
// Recent moderation + settings-change events for this chat, filtered by
// time range (24h / 7d / all-time) and paginated.
//
// Read-only. Access: `group_admin`. Data source: ModLog collection
// (helpers/mod-log.js). This screen only renders; log writes live wherever
// the underlying action happens (handlers/banan.js, handlers/spam-vote.js,
// the settings subscreens, etc.).

const { registerMenu } = require('../registry')
const { cb, btn, row, backBtn, NOOP } = require('../keyboard')
const { renderEmptyState } = require('../empty-state')
const { countRecent, rangeSince } = require('../../mod-log')
const { resolveTargetChatId } = require('../pm-context')
const { escapeHtml } = require('../../text-utils')
const { bot: log } = require('../../logger')

const SCREEN_ID = 'settings.modlog'
const PAGE_SIZE = 8
const DEFAULT_RANGE = '24h'
const VALID_RANGES = ['24h', '7d', 'all']

// Emoji prefix by eventType — keeps rows scannable at a glance.
const EMOJI_BY_TYPE = {
  manual_ban: '⚔️',
  manual_mute: '⚔️',
  manual_kick: '🥾',
  manual_del: '🗑',
  auto_ban: '🤖',
  auto_mute: '🤖',
  auto_del: '🧹',
  override: '↩️',
  vote_resolved: '🗳',
  trust: '👍',
  untrust: '👎',
  settings_change: '⚙️'
}

// Short locale key for each eventType. Renderer interpolates actor/target.
const LABEL_KEY_BY_TYPE = {
  manual_ban: 'menu.settings.modlog.row.manual_ban',
  manual_mute: 'menu.settings.modlog.row.manual_mute',
  manual_kick: 'menu.settings.modlog.row.manual_kick',
  manual_del: 'menu.settings.modlog.row.manual_del',
  auto_ban: 'menu.settings.modlog.row.auto_ban',
  auto_mute: 'menu.settings.modlog.row.auto_mute',
  auto_del: 'menu.settings.modlog.row.auto_del',
  override: 'menu.settings.modlog.row.override',
  vote_resolved: 'menu.settings.modlog.row.vote_resolved',
  trust: 'menu.settings.modlog.row.trust',
  untrust: 'menu.settings.modlog.row.untrust',
  settings_change: 'menu.settings.modlog.row.settings_change'
}

const pad2 = (n) => String(n).padStart(2, '0')

// HH:MM — compact enough to fit beside the emoji + names in a one-liner.
const formatTime = (date) => {
  const d = date instanceof Date ? date : new Date(date)
  if (!d || isNaN(d.getTime())) return '??:??'
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const displayName = (name) => escapeHtml(name || '—')

const renderRow = (ctx, entry) => {
  const key = LABEL_KEY_BY_TYPE[entry.eventType] || 'menu.settings.modlog.row.default'
  const emoji = EMOJI_BY_TYPE[entry.eventType] || '•'
  const time = formatTime(entry.timestamp)
  const body = ctx.i18n.t(key, {
    actor: displayName(entry.actorName || ctx.i18n.t('menu.settings.modlog.actor.bot')),
    target: displayName(entry.targetName),
    action: escapeHtml(entry.action || '')
  })
  return `${time} ${emoji} ${body}`
}

const rangeLabelKey = (range) => {
  if (range === '7d') return 'menu.settings.modlog.range.7d'
  if (range === 'all') return 'menu.settings.modlog.range.all'
  return 'menu.settings.modlog.range.24h'
}

const buildRangeRow = (ctx, activeRange) => {
  const marker = ctx.i18n.t('menu.settings.modlog.active_marker')
  const rangeBtn = (r, labelKey) => btn(
    (r === activeRange ? marker : '') + ctx.i18n.t(labelKey),
    cb(SCREEN_ID, 'range', r)
  )
  return [
    rangeBtn('24h', 'menu.settings.modlog.btn.24h'),
    rangeBtn('7d', 'menu.settings.modlog.btn.7d'),
    rangeBtn('all', 'menu.settings.modlog.btn.all')
  ]
}

// Pagination buttons carry the current range in their callback args so the
// rerender can preserve the filter. Without this the page-click would fall
// through to DEFAULT_RANGE on rerender.
const buildPaginationRow = (page, totalPages, range) => {
  if (totalPages <= 1) return null
  const prevCb = page > 0 ? cb(SCREEN_ID, 'page', String(page - 1), range) : NOOP
  const nextCb = page < totalPages - 1 ? cb(SCREEN_ID, 'page', String(page + 1), range) : NOOP
  return [
    btn('‹', prevCb),
    btn(`${page + 1} / ${totalPages}`, NOOP),
    btn('›', nextCb)
  ]
}

const render = async (ctx, state = {}) => {
  const range = VALID_RANGES.includes(state.range) ? state.range : DEFAULT_RANGE
  const page = Math.max(0, parseInt(state.page, 10) || 0)
  // In PM, ctx.chat.id is the DM; resolveTargetChatId picks the real group.
  const chatId = resolveTargetChatId(ctx)

  const since = rangeSince(range)

  let total = 0
  let entries = []
  try {
    total = await countRecent(ctx.db, chatId, { since })
    if (total > 0) {
      // Offset-based pagination via count + skip via cursor date is harder
      // with a simple limit; we fall back to .skip() via the Mongoose model
      // for simplicity (ModLog is small by TTL).
      entries = await ctx.db.ModLog.find(
        Object.assign({ chatId }, since ? { timestamp: { $gte: since } } : {})
      )
        .sort({ timestamp: -1 })
        .skip(page * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean()
    }
  } catch (err) {
    log.debug({ err, chatId }, 'settings.modlog: query failed')
    // Fall through to empty-state. Users don't need to see a query-error toast.
  }

  // Always include range selector + back, even on empty state.
  const backRow = row(backBtn('settings.root', { label: ctx.i18n.t('menu.settings.common.back') }))

  if (entries.length === 0) {
    const rangeLabel = ctx.i18n.t(rangeLabelKey(range))
    const empty = renderEmptyState(ctx.i18n, {
      titleKey: 'menu.settings.modlog.empty_title',
      descKey: 'menu.settings.modlog.empty_hint'
    })
    // Add range selector + back.
    empty.keyboard.inline_keyboard.push(buildRangeRow(ctx, range))
    empty.keyboard.inline_keyboard.push(backRow)
    // Override title with range label.
    empty.text = ctx.i18n.t('menu.settings.modlog.empty_text', { range: rangeLabel }) +
      '\n\n' + empty.text
    return empty
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const lines = entries.map(e => renderRow(ctx, e)).join('\n')
  const text = ctx.i18n.t('menu.settings.modlog.text', {
    range: ctx.i18n.t(rangeLabelKey(range)),
    total,
    list: lines
  })

  const kb = []
  kb.push(buildRangeRow(ctx, range))
  const pag = buildPaginationRow(page, totalPages, range)
  if (pag) kb.push(pag)
  kb.push(backRow)
  return { text, keyboard: { inline_keyboard: kb } }
}

const handle = async (ctx, action, args) => {
  if (action === 'range') {
    const r = args && args[0]
    if (!VALID_RANGES.includes(r)) return { render: false }
    // Reset page when range changes.
    return { render: true, state: { range: r, page: 0 } }
  }
  if (action === 'page') {
    const p = parseInt(args && args[0], 10)
    if (!Number.isFinite(p) || p < 0) return { render: false }
    const r = (args && args[1] && VALID_RANGES.includes(args[1])) ? args[1] : DEFAULT_RANGE
    return { render: true, state: { page: p, range: r } }
  }
  return { render: false }
}

const register = () => {
  registerMenu({
    id: SCREEN_ID,
    access: 'group_admin',
    render,
    handle
  })
}

module.exports = {
  register,
  SCREEN_ID,
  PAGE_SIZE,
  VALID_RANGES,
  DEFAULT_RANGE,
  EMOJI_BY_TYPE,
  LABEL_KEY_BY_TYPE,
  formatTime,
  renderRow,
  render,
  handle
}
