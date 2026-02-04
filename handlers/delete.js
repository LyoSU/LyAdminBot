const { mapTelegramError } = require('../helpers/error-mapper')

module.exports = async (ctx) => {
  const chatMember = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id)

  await ctx.deleteMessage(ctx.message.message_id).catch((error) => {
    const errorKey = mapTelegramError(error, 'del')
    return ctx.replyWithHTML(ctx.i18n.t(errorKey))
  })
  if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
    if (ctx.message.reply_to_message) {
      await ctx.deleteMessage(ctx.message.reply_to_message.message_id).catch((error) => {
        const errorKey = mapTelegramError(error, 'del')
        return ctx.replyWithHTML(ctx.i18n.t(errorKey))
      })
    }
  }
}
