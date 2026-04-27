// /settings (and !settings alias) — entry point.
//
// UX contract (Apr-2026): admin panels NEVER render in-group. Settings in a
// group chat would be visible to all members and socially awkward to poke at,
// so we bounce with a minimal 1-line hint + a URL button that deep-links to
// the bot's PM where the panel renders privately (see handlers/start.js).
//
// Non-admin in group: short rejection reply.
// Private chat: the /start deep-link flow is the intended entry; raw /settings
// in DM has no chat context, so we bounce with a hint.

const { replyHTML } = require('../helpers/reply-html')
const { isAdmin } = require('../helpers/menu/access')
const { scheduleDeletion } = require('../helpers/message-cleanup')
const policy = require('../helpers/cleanup-policy')
const { bot: log } = require('../helpers/logger')

const buildPmRedirect = (ctx) => {
  const botUsername = (ctx.botInfo && ctx.botInfo.username) || 'LyAdminBot'
  const chatId = ctx.chat && ctx.chat.id
  const url = `https://t.me/${botUsername}?start=settings_${chatId}`
  const text = ctx.i18n.t('menu.settings.open_in_pm.text')
  const keyboard = {
    inline_keyboard: [[
      { text: ctx.i18n.t('menu.settings.open_in_pm.btn'), url }
    ]]
  }
  return { text, keyboard }
}

const handleSettings = async (ctx) => {
  if (!ctx.chat || !['supergroup', 'group'].includes(ctx.chat.type)) {
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

  const { text, keyboard } = buildPmRedirect(ctx)

  let sent = null
  try {
    sent = await replyHTML(ctx, text, {
      reply_markup: keyboard,
      reply_to_message_id: ctx.message && ctx.message.message_id
    })
  } catch (err) {
    log.warn({ err }, 'handleSettings: reply failed')
    return
  }

  if (sent && sent.message_id && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: sent.message_id,
      delayMs: policy.cmd_help,
      source: 'cmd_settings_pm_redirect'
    }, ctx.telegram).catch(() => {})
  }
  if (ctx.message && ctx.message.message_id && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      delayMs: policy.cmd_help,
      source: 'cmd_settings_pm_redirect'
    }, ctx.telegram).catch(() => {})
  }
}

module.exports = handleSettings
module.exports.buildPmRedirect = buildPmRedirect
