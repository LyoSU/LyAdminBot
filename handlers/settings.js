// /settings (and !settings alias) — entry point into the settings panel.
//
// Group-only: in private chats we silently redirect to the deep-link suggestion
// (the deep-link is handled by /start, not here). Non-admin group members get
// a short rejection reply.
//
// Admin → send a fresh message with settings.root rendered inline. We do NOT
// use the usual renderScreen() here because it expects a callback context
// (editMessageText); instead we render the view manually and send as a new
// message. Subsequent button clicks flow through the regular router.

const { replyHTML } = require('../helpers/reply-html')
const { getMenu } = require('../helpers/menu/registry')
const { isAdmin } = require('../helpers/menu/access')
const { scheduleDeletion } = require('../helpers/message-cleanup')
const policy = require('../helpers/cleanup-policy')
const { bot: log } = require('../helpers/logger')

const handleSettings = async (ctx) => {
  if (!ctx.chat || !['supergroup', 'group'].includes(ctx.chat.type)) {
    // Private chat: /start with a settings_<chatId> deep-link handles this
    // path. Raw /settings in DM has no chat context, so we bounce with a hint.
    try {
      await replyHTML(ctx, ctx.i18n.t('only_group'))
    } catch { /* ignore */ }
    return
  }

  if (!(await isAdmin(ctx))) {
    try {
      await ctx.replyWithHTML(ctx.i18n.t('only_admin'), {
        reply_to_message_id: ctx.message && ctx.message.message_id
      })
    } catch { /* ignore */ }
    return
  }

  const root = getMenu('settings.root')
  if (!root) {
    log.warn('handleSettings: settings.root not registered')
    return
  }

  let view
  try {
    view = await root.render(ctx, {})
  } catch (err) {
    log.warn({ err: err.message }, 'handleSettings: render failed')
    return
  }
  if (!view || !view.text) return

  let sent = null
  try {
    sent = await replyHTML(ctx, view.text, view.keyboard ? { reply_markup: view.keyboard } : {})
  } catch (err) {
    log.warn({ err: err.message }, 'handleSettings: reply failed')
    return
  }

  // Auto-delete idle settings menu after cmd_settings_idle TTL.
  if (sent && sent.message_id && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: sent.message_id,
      delayMs: policy.cmd_settings_idle,
      source: 'cmd_settings_idle'
    }, ctx.telegram).catch(() => {})
  }
  // Also clean up the invoking command so the chat stays tidy.
  if (ctx.message && ctx.message.message_id && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      delayMs: policy.cmd_settings_idle,
      source: 'cmd_settings_idle'
    }, ctx.telegram).catch(() => {})
  }
}

module.exports = handleSettings
