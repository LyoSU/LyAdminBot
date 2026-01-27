const { scheduleDeletion } = require('../helpers/message-cleanup')

module.exports = async (ctx) => {
  const message = await ctx.replyWithHTML(ctx.i18n.t('cmd.help'), {
    reply_to_message_id: ctx.message.message_id
  })

  if (['supergroup', 'group'].includes(ctx.chat.type) && ctx.db) {
    const delayMs = 60 * 1000
    // Delete bot's response
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: message.message_id,
      delayMs,
      source: 'cmd_help'
    }, ctx.telegram)
    // Delete user's command
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      delayMs,
      source: 'cmd_help'
    }, ctx.telegram)
  }
}
