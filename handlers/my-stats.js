// /mystats — per-user stats panel.
//
// Render surface per §11 of the UX spec:
//
//   📊 Стата {name} в {chatName}
//
//   🍌 Бананів:       12
//   ⏲ Всього в бані: 4 год 22 хв
//   ⚡ Автобан:        1 год
//
//   💬 Повідомлень:   1 247
//   📈 Актив:   ▮▮▮▮▮▮▮▱▱▱  72%
//   🌊 Флуд:    ▮▮▱▱▱▱▱▱▱▱  18%
//
//   📅 Тут з: 2024-03-15
//   🎖 Ветеран чату
//
// Entry paths:
//   1. /mystats in a group — sends the panel to the user's DM and posts a
//      short "stats sent" reply in the group. Both messages auto-delete.
//   2. Deep-link ?start=mystats_<chatId> — private-chat invocation, resolves
//      the target Group + GroupMember by chatId for the user and renders the
//      panel directly in the DM.
//
// Metrics:
//   activity% = (member.textTotal / group.textTotal) * 100, capped 100
//   flood%    = min(100, (member.avgMsgLen / group.avgMsgLen - 1) * 100) when
//               the member's avg is above the group's avg; otherwise 0. If
//               there's no group data yet we fall back to (banCount /
//               messages) * 100 capped 100 — a best-effort "spam-signal
//               density" proxy until the schema grows a proper per-period
//               break-out. Documented in PLAN 8 final report.

const humanizeDuration = require('humanize-duration')
const dateFormat = require('dateformat')
const { userName } = require('../utils')
const { replyHTML } = require('../helpers/reply-html')
const { scheduleDeletion } = require('../helpers/message-cleanup')
const { bar } = require('../helpers/text-utils')
const policy = require('../helpers/cleanup-policy')
const { bot: log } = require('../helpers/logger')

const AUTO_DELETE_MS = 3 * 1000

/**
 * Pick a fun badge based on stats (pure — tests can exercise this directly).
 */
function getStatsBadge (i18n, member, activePct, floodPct, messages, banCount) {
  const memberAge = member && member.createdAt
    ? Date.now() - new Date(member.createdAt).getTime()
    : 0
  const sixMonths = 6 * 30 * 24 * 60 * 60 * 1000

  if (messages > 100 && banCount === 0) return i18n.t('cmd.my_stats.badge.exemplary')
  if (banCount >= 10) return i18n.t('cmd.my_stats.badge.collector')
  if (activePct > 15) return i18n.t('cmd.my_stats.badge.soul')
  if (floodPct > 80) return i18n.t('cmd.my_stats.badge.flood_master')
  if (memberAge > sixMonths && messages > 50) return i18n.t('cmd.my_stats.badge.veteran')
  if (activePct < 1 && memberAge > 30 * 24 * 60 * 60 * 1000) return i18n.t('cmd.my_stats.badge.silent')
  if (memberAge > 0 && memberAge < 7 * 24 * 60 * 60 * 1000) return i18n.t('cmd.my_stats.badge.newbie')
  return ''
}

/**
 * Compute the render-ready stats payload. Pure — no I/O. Unit-testable.
 *
 * @param {object} input
 * @param {object} input.member - GroupMember doc (banan, stats, createdAt)
 * @param {object} input.group  - Group doc (stats, settings.banan.default)
 * @param {object} input.from   - Telegram user (first_name, username)
 * @param {string} input.chatName
 * @param {object} input.i18n   - Telegraf-i18n instance (t(), locale())
 * @returns {{ text: string, activityPercent: number, floodPercent: number }}
 */
function computeMyStats ({ member, group, from, chatName, i18n }) {
  const memberStats = (member && member.stats) || { messagesCount: 0, textTotal: 0 }
  const groupStats = (group && group.stats) || { messagesCount: 0, textTotal: 0 }
  const banan = (member && member.banan) || { num: 0, sum: 0, stack: 0 }
  const banDefault = (group && group.settings && group.settings.banan && group.settings.banan.default) || 300

  const messages = memberStats.messagesCount || 0
  const banCount = banan.num || 0

  // Activity%: share of the group's total text produced by this member.
  let activityPercent = 0
  if (groupStats.textTotal > 0) {
    activityPercent = Math.min(100, (memberStats.textTotal * 100) / groupStats.textTotal)
  }

  // Flood%: ratio of this member's avg message length versus the group avg.
  // Positive deltas only (sub-average chatters aren't flooders). When the
  // group has no corpus yet we fall back to a crude ban-density proxy so
  // the value isn't misleadingly 0 for restricted members.
  let floodPercent = 0
  const memberAvg = messages > 0 ? memberStats.textTotal / messages : 0
  const groupAvg = groupStats.messagesCount > 0 ? groupStats.textTotal / groupStats.messagesCount : 0
  if (groupAvg > 0) {
    if (memberAvg > groupAvg) {
      floodPercent = Math.min(100, Math.round(((memberAvg / groupAvg) - 1) * 100))
    }
    // else: sub-average chatters stay at 0 — not flooders by definition.
  } else if (messages > 0) {
    floodPercent = Math.min(100, Math.round((banCount / messages) * 100))
  }

  const activityBar = bar(activityPercent, 10)
  const floodBar = bar(floodPercent, 10)

  const banTime = humanizeDuration(
    (banan.sum || 0) * 1000,
    { language: i18n.locale(), fallbacks: ['en'], largest: 2, round: true }
  )
  const banAutoTime = humanizeDuration(
    (banan.stack || 0) * banDefault * 1000,
    { language: i18n.locale(), fallbacks: ['en'], largest: 2, round: true }
  )

  const joinedAt = member && member.createdAt
    ? dateFormat(member.createdAt, 'dd.mm.yyyy')
    : '—'

  const badge = getStatsBadge(i18n, member, activityPercent, floodPercent, messages, banCount)
  const badgeLine = badge ? `\n${badge}` : ''

  const text = i18n.t('menu.stats.mystats.text', {
    name: userName(from, true),
    chatName,
    banCount,
    banTime,
    banAutoTime,
    messages,
    activityBar,
    activityPercent: Math.round(activityPercent),
    floodBar,
    floodPercent: Math.round(floodPercent),
    joinedAt,
    badge: badgeLine
  })

  return { text, activityPercent, floodPercent }
}

/**
 * Resolve Group + GroupMember for deep-link path. Returns null on any miss.
 */
async function resolveChatMember (ctx, chatId) {
  if (!ctx.db) return null
  try {
    const group = await ctx.db.Group.findOne({ group_id: chatId })
    if (!group) return null
    const member = await ctx.db.GroupMember.findOne({
      group: group._id,
      telegram_id: ctx.from.id
    })
    return { group, member }
  } catch (err) {
    log.debug({ err: err.message }, 'mystats: resolve failed')
    return null
  }
}

/**
 * Send the stats panel as a private message to ctx.from. Used by both the
 * /mystats group path and the deep-link DM path.
 * Returns the sent Message or null (e.g. user blocked the bot).
 */
async function sendStatsToPM (ctx, { member, group, chatName }) {
  const { text } = computeMyStats({
    member,
    group,
    from: ctx.from,
    chatName,
    i18n: ctx.i18n
  })

  try {
    return await ctx.telegram.callApi('sendMessage', {
      chat_id: ctx.from.id,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      disable_web_page_preview: true
    })
  } catch (_err) {
    return null
  }
}

// Main command entry. Private chat = deep-link path (rendered in `start.js`).
module.exports = async (ctx) => {
  if (!['supergroup', 'group'].includes(ctx.chat.type)) return

  const member = ctx.group && ctx.group.members && ctx.group.members[ctx.from.id]
  const group = ctx.group && ctx.group.info
  if (!member || !group) {
    return ctx.replyWithHTML(ctx.i18n.t('menu.stats.mystats.blocked')).catch(() => {})
  }

  const chatName = ctx.chat.title || ''
  const pmMessage = await sendStatsToPM(ctx, { member, group, chatName })

  let groupAck
  if (pmMessage) {
    groupAck = await replyHTML(ctx, ctx.i18n.t('menu.stats.mystats.send_pm'), {
      reply_to_message_id: ctx.message.message_id
    }).catch(() => null)
  } else {
    groupAck = await replyHTML(ctx, ctx.i18n.t('menu.stats.mystats.blocked'), {
      reply_to_message_id: ctx.message.message_id
    }).catch(() => null)
  }

  if (groupAck && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: groupAck.message_id,
      delayMs: AUTO_DELETE_MS,
      source: 'cmd_stats'
    }, ctx.telegram).catch(() => {})
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      delayMs: AUTO_DELETE_MS,
      source: 'cmd_stats'
    }, ctx.telegram).catch(() => {})
  }
}

/**
 * Deep-link entry point for `?start=mystats_<chatId>`. Called from start.js.
 * Renders the panel in the private chat if the bot knows the chat + member.
 */
module.exports.handleDeepLink = async (ctx, chatId) => {
  const resolved = await resolveChatMember(ctx, chatId)
  if (!resolved || !resolved.group || !resolved.member) {
    return false
  }
  const chatName = resolved.group.title || ''
  const { text } = computeMyStats({
    member: resolved.member,
    group: resolved.group,
    from: ctx.from,
    chatName,
    i18n: ctx.i18n
  })
  try {
    await replyHTML(ctx, text)
    // Auto-clean the placeholder isn't needed in DM — users own their chats.
    // We still let policy decide.
    void policy
    return true
  } catch (err) {
    log.debug({ err: err.message }, 'mystats deep-link send failed')
    return false
  }
}

module.exports.computeMyStats = computeMyStats
module.exports.getStatsBadge = getStatsBadge
