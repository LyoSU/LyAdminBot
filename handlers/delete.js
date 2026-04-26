const { mapTelegramError } = require('../helpers/error-mapper')
const { isSenderAdmin } = require('../helpers/is-sender-admin')
const { logModEvent } = require('../helpers/mod-log')
const { sendRightsCard } = require('../helpers/menu/screens/mod-rights')

module.exports = async (ctx) => {
  const isAdmin = await isSenderAdmin(ctx)

  // Always delete the /del command message itself (non-undoable; the
  // admin explicitly asked). If that fails, surface the rich rights
  // card so the admin actually knows what permission is missing.
  await ctx.deleteMessage(ctx.message.message_id).catch(async (error) => {
    const errorKey = mapTelegramError(error, 'del')
    if (errorKey.endsWith('error_no_rights')) {
      try { await sendRightsCard(ctx, { action: 'del' }) } catch (_err) { /* ignore */ }
      return
    }
    return ctx.replyWithHTML(ctx.i18n.t(errorKey))
  })

  if (isAdmin && ctx.message.reply_to_message) {
    const target = ctx.message.reply_to_message

    let deleted = false
    await ctx.deleteMessage(target.message_id).then(() => {
      deleted = true
    }).catch(async (error) => {
      const errorKey = mapTelegramError(error, 'del')
      if (errorKey.endsWith('error_no_rights')) {
        try { await sendRightsCard(ctx, { action: 'del' }) } catch (_err) { /* ignore */ }
        return
      }
      return ctx.replyWithHTML(ctx.i18n.t(errorKey))
    })

    if (deleted) {
      logModEvent(ctx.db, {
        chatId: ctx.chat.id,
        eventType: 'manual_del',
        actor: ctx.from,
        target: target.from
      }).catch(() => {})
    }
  }
}
