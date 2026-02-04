const { bot: botLog } = require('../helpers/logger')

module.exports = async (ctx, next) => {
  if (['supergroup', 'group'].includes(ctx.chat.type)) {
    let chatMember
    let apiError = false

    try {
      chatMember = await ctx.tg.getChatMember(
        ctx.message.chat.id,
        ctx.message.from.id
      )
    } catch (err) {
      botLog.error({ err }, 'Failed to get chat member')
      apiError = true
    }

    if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
      return next()
    } else if (apiError) {
      // On API error, don't block the user - they might be an admin
      // Log and allow through to avoid false denials
      botLog.warn({ userId: ctx.from.id, chatId: ctx.chat.id }, 'Admin check failed, allowing through')
      return next()
    } else {
      await ctx.replyWithHTML(ctx.i18n.t('only_admin'), {
        reply_to_message_id: ctx.message.message_id
      })
    }
  } else {
    return next()
  }
}
