const { userName } = require('../utils')
const { mapTelegramError } = require('../helpers/error-mapper')
const { isSenderAdmin } = require('../helpers/is-sender-admin')
const { replyHTML } = require('../helpers/reply-html')
const modEvent = require('../helpers/mod-event')
const { scheduleDeletion } = require('../helpers/message-cleanup')
const policy = require('../helpers/cleanup-policy')
const { sendRightsCard } = require('../helpers/menu/screens/mod-rights')

// Emit the unified mod-event result message with `[↩️ Скасувати]` button.
// Returns the sent message (or null on failure).
const sendKickResult = async (ctx, { kickUser, adminUser }) => {
  let event = null
  if (ctx.db && ctx.db.ModEvent) {
    try {
      event = await modEvent.createModEvent(ctx.db, {
        chatId: ctx.chat.id,
        actorId: adminUser && adminUser.id,
        actorName: adminUser && (adminUser.first_name || adminUser.username),
        targetId: kickUser.id,
        targetName: kickUser.first_name,
        targetUsername: kickUser.username,
        actionType: 'manual_kick'
      })
    } catch (_err) { /* best-effort */ }
  }

  const text = ctx.i18n.t('kick.suc', { name: userName(kickUser, true) })
  const keyboard = event
    ? modEvent.buildCompactKeyboard(ctx.i18n, event)
    : { inline_keyboard: [] }

  let sent
  try {
    sent = await replyHTML(ctx, text, { reply_markup: keyboard })
  } catch (_err) {
    return null
  }

  if (sent && sent.message_id && event && ctx.db) {
    try {
      await modEvent.updateModEvent(ctx.db, event.eventId, {
        notificationChatId: ctx.chat.id,
        notificationMessageId: sent.message_id
      })
    } catch (_err) { /* best-effort */ }
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: sent.message_id,
      delayMs: policy.banan_undo,
      source: 'kick_undo'
    }, ctx.telegram).catch(() => {})
  }
  return sent
}

module.exports = async (ctx) => {
  const isAdmin = await isSenderAdmin(ctx)
  let kickUser

  if (isAdmin) {
    if (ctx.message.reply_to_message) {
      kickUser = ctx.message.reply_to_message.from
    } else {
      ctx.replyWithHTML(ctx.i18n.t('kick.who'))
    }
  } else {
    kickUser = ctx.from
  }

  if (!kickUser) return

  const isSelfKick = ctx.from.id === kickUser.id

  try {
    await ctx.telegram.unbanChatMember(ctx.chat.id, kickUser.id)
  } catch (error) {
    const errorKey = mapTelegramError(error, 'kick')
    if (errorKey.endsWith('error_no_rights')) {
      try { await sendRightsCard(ctx, { action: 'kick', targetUser: kickUser }) } catch (_err) { /* ignore */ }
      return
    }
    return ctx.replyWithHTML(ctx.i18n.t(errorKey))
  }

  // Self-kick and non-admin self-kick use the existing easter-egg replies
  // without the undo button — the kickee is the caller, undo makes no
  // sense. Admin-on-target kicks get the unified card.
  if (isSelfKick) {
    const msgKey = isAdmin ? 'kick.easter.admin_self' : 'kick.easter.self'
    return ctx.replyWithHTML(ctx.i18n.t(msgKey, { name: userName(kickUser, true) }))
  }

  if (isAdmin) {
    const sent = await sendKickResult(ctx, { kickUser, adminUser: ctx.from })
    if (sent) return
    // Fall through on send failure.
  }

  return ctx.replyWithHTML(ctx.i18n.t('kick.suc', { name: userName(kickUser, true) }))
}
