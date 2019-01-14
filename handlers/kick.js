const { userLogin } = require('../lib')

module.exports = async (ctx) => {
  ctx.mixpanel.track('kick')
  const chatMember = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id)

  if (chatMember.status === 'creator' || chatMember.status === 'administrator') {
    if (ctx.message.reply_to_message) {
      var kickUser = ctx.message.reply_to_message.from
    } else {
      ctx.replyWithHTML(
        ctx.i18n.t('kick.who')
      )
    }
  } else {
    var kickUser = ctx.from
  }

  if (kickUser) {
    ctx.telegram.unbanChatMember(ctx.chat.id, kickUser.id).then(() => {
      ctx.replyWithHTML(
        ctx.i18n.t('kick.suc', {
          login: userLogin(kickUser, true)
        })
      )
    })
  }
}
