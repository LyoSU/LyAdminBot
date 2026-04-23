// /top_banan — top banana-collectors leaderboard.
//
// Thin shim over helpers/menu/screens/stats-top-banan.js.

const { replyHTML } = require('../helpers/reply-html')
const { getMenu } = require('../helpers/menu/registry')
const { scheduleDeletion } = require('../helpers/message-cleanup')
const policy = require('../helpers/cleanup-policy')
const { bot: log } = require('../helpers/logger')

const SCREEN_ID = 'stats.top_banan'

module.exports = async (ctx) => {
  const screen = getMenu(SCREEN_ID)
  if (!screen) {
    log.warn('handleTopBanan: stats.top_banan not registered')
    return
  }

  let view
  try {
    view = await screen.render(ctx, { page: 0 })
  } catch (err) {
    log.warn({ err: err.message }, 'handleTopBanan: render failed')
    return
  }
  if (!view || !view.text) return

  let sent
  try {
    sent = await replyHTML(ctx, view.text, {
      reply_markup: view.keyboard || { inline_keyboard: [] },
      reply_to_message_id: ctx.message && ctx.message.message_id
    })
  } catch (err) {
    log.warn({ err: err.message }, 'handleTopBanan: send failed')
    return
  }

  if (sent && sent.message_id && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: sent.message_id,
      delayMs: policy.cmd_settings_idle,
      source: 'cmd_top_banan'
    }, ctx.telegram).catch(() => {})
  }
  if (ctx.message && ctx.message.message_id && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      delayMs: policy.cmd_settings_idle,
      source: 'cmd_top_banan'
    }, ctx.telegram).catch(() => {})
  }
}
