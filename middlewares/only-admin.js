const { isSenderAdmin } = require('../helpers/is-sender-admin')

module.exports = async (ctx, next) => {
  if (!['supergroup', 'group'].includes(ctx.chat.type)) {
    return next()
  }

  if (await isSenderAdmin(ctx)) {
    return next()
  }

  await ctx.replyWithHTML(ctx.i18n.t('only_admin'), {
    reply_to_message_id: ctx.message.message_id
  })
}
