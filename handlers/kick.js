const { userName } = require('../utils')


module.exports = async (ctx) => {
  const chatMember = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id)
  let kickUser

  if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
    if (ctx.message.reply_to_message) {
      kickUser = ctx.message.reply_to_message.from
    }
    else {
      ctx.replyWithHTML(ctx.i18n.t('kick.who'))
    }
  }
  else {
    kickUser = ctx.from
  }

  if (kickUser) {
    await ctx.telegram.unbanChatMember(ctx.chat.id, kickUser.id).then(() => {
      ctx.replyWithHTML(ctx.i18n.t('kick.suc', {
        name: userName(kickUser, true),
      }))
    }).catch((error) => {
      return ctx.replyWithHTML(ctx.i18n.t('kick.error', {
        error,
      }))
    })
  }
}
