const { mapTelegramError } = require('../helpers/error-mapper')
const { isSenderAdmin } = require('../helpers/is-sender-admin')

module.exports = async (ctx) => {
  const isAdmin = await isSenderAdmin(ctx)

  await ctx.deleteMessage(ctx.message.message_id).catch((error) => {
    const errorKey = mapTelegramError(error, 'del')
    return ctx.replyWithHTML(ctx.i18n.t(errorKey))
  })
  if (isAdmin && ctx.message.reply_to_message) {
    await ctx.deleteMessage(ctx.message.reply_to_message.message_id).catch((error) => {
      const errorKey = mapTelegramError(error, 'del')
      return ctx.replyWithHTML(ctx.i18n.t(errorKey))
    })
  }
}
