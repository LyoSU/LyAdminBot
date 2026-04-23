const { mapTelegramError } = require('../helpers/error-mapper')
const { isSenderAdmin } = require('../helpers/is-sender-admin')
const buffer = require('../helpers/delete-buffer')
const { sendUndoNotification } = require('../helpers/menu/screens/mod-del-undo')
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
    // Snapshot BEFORE deletion — once the message is gone we can't
    // getChatMember-read it, only what Telegram already delivered to us.
    buffer.put(ctx.chat.id, target.message_id, target)

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
      // Best-effort undo notification. Failure is purely cosmetic — the
      // delete already succeeded. Notification self-expires via the
      // standard cleanup queue.
      await sendUndoNotification(ctx, {
        chatId: ctx.chat.id,
        messageId: target.message_id
      }).catch(() => {})
    } else {
      // Delete failed — drop the buffer entry so an orphaned undo
      // notification can never resurface the message from cache.
      buffer.del(ctx.chat.id, target.message_id)
    }
  }
}
