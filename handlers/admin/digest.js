// /digest — on-demand weekly digest. Admin-only, group-scoped.
//
// Flow:
//   1. Admin runs /digest in a group they moderate
//   2. Bot computes last-7-days stats from ModLog
//   3. Bot PMs the formatted digest to the caller (not the whole group)
//   4. Bot acks in the group with a 3s auto-deleting "скинув в особисті"
//
// If the caller hasn't started a DM with the bot, Telegram returns 403.
// We handle that the same way /mystats does — ack the failure in-group
// and point them at the bot's username.
//
// The scheduler (helpers/digest-scheduler.js) re-uses computeDigestStats +
// renderDigest from helpers/digest-stats.js, so the two paths produce
// identical output for the same stats window.

const { isSenderAdmin } = require('../../helpers/is-sender-admin')
const { computeDigestStats, renderDigest, isWorthSending } = require('../../helpers/digest-stats')
const { scheduleDeletion } = require('../../helpers/message-cleanup')
const { replyHTML } = require('../../helpers/reply-html')
const emojiMap = require('../../helpers/emoji-map')
const { bot: log } = require('../../helpers/logger')

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const ACK_AUTO_DELETE_MS = 3 * 1000

module.exports = async (ctx) => {
  if (!ctx.chat || !['supergroup', 'group'].includes(ctx.chat.type)) return
  if (!ctx.db || !ctx.db.ModLog) return
  if (!ctx.message) return

  const isAdmin = await isSenderAdmin(ctx)
  if (!isAdmin) {
    // Silent ignore for non-admins — same pattern as other admin commands.
    return
  }

  const now = new Date()
  const since = new Date(now.getTime() - WEEK_MS)

  let stats
  try {
    stats = await computeDigestStats(ctx.db, ctx.chat.id, { since, now })
  } catch (err) {
    log.warn({ err, chatId: ctx.chat.id }, 'digest: compute failed')
    return
  }

  const chatTitle = ctx.chat.title || ''
  const text = renderDigest(stats, { chatTitle, e: emojiMap, i18n: ctx.i18n })

  // For on-demand /digest we send even if the week was empty — the admin
  // explicitly asked. The scheduler skips empty weeks to avoid spam.
  const deliveredViaPM = await sendToPM(ctx, text)

  const ackText = deliveredViaPM
    ? ctx.i18n.t('digest.cmd.delivered', { chart: emojiMap.chart })
    : ctx.i18n.t('digest.cmd.pm_blocked', { warn: emojiMap.warn })

  const ack = await replyHTML(ctx, ackText, {
    reply_to_message_id: ctx.message.message_id,
    disable_web_page_preview: true
  }).catch(() => null)

  if (ack && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: ack.message_id,
      delayMs: ACK_AUTO_DELETE_MS,
      source: 'cmd_digest'
    }, ctx.telegram).catch(() => {})
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      delayMs: ACK_AUTO_DELETE_MS,
      source: 'cmd_digest'
    }, ctx.telegram).catch(() => {})
  }

  log.debug({
    chatId: ctx.chat.id,
    adminId: ctx.from.id,
    totalEvents: stats ? stats.totalEvents : 0,
    delivered: deliveredViaPM,
    empty: stats ? !isWorthSending(stats) : true
  }, 'digest: on-demand generated')
}

async function sendToPM (ctx, htmlText) {
  try {
    await ctx.telegram.callApi('sendMessage', {
      chat_id: ctx.from.id,
      text: htmlText,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      disable_web_page_preview: true
    })
    return true
  } catch (_err) {
    return false
  }
}
