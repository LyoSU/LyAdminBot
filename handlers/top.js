// /top — top active members leaderboard.
//
// Thin shim: the real work lives in helpers/menu/screens/stats-top.js. This
// handler just renders page 0 and sends it as a fresh message (like
// handlers/settings.js). Subsequent pagination clicks go through the
// standard menu router → renderScreen.

const { replyHTML } = require('../helpers/reply-html')
const { getMenu } = require('../helpers/menu/registry')
const { scheduleDeletion } = require('../helpers/message-cleanup')
const policy = require('../helpers/cleanup-policy')
const { bot: log } = require('../helpers/logger')

const SCREEN_ID = 'stats.top'

module.exports = async (ctx) => {
  const screen = getMenu(SCREEN_ID)
  if (!screen) {
    log.warn('handleTop: stats.top not registered')
    return
  }

  let view
  try {
    view = await screen.render(ctx, { page: 0 })
  } catch (err) {
    log.warn({ err: err.message }, 'handleTop: render failed')
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
    log.warn({ err: err.message }, 'handleTop: send failed')
    return
  }

  // Auto-delete the leaderboard + the invoking command after a reasonable
  // idle window. Pagination keeps the message alive by re-rendering in-place.
  if (sent && sent.message_id && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: sent.message_id,
      delayMs: policy.cmd_settings_idle,
      source: 'cmd_top'
    }, ctx.telegram).catch(() => {})
  }
  if (ctx.message && ctx.message.message_id && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      delayMs: policy.cmd_settings_idle,
      source: 'cmd_top'
    }, ctx.telegram).catch(() => {})
  }
}
