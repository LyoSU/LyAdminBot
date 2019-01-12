module.exports = async (ctx) => {
  ctx.mixpanel.track('kick')
  await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id).then((result) => chatStatus = result.status)

  if (chatStatus === 'creator' || chatStatus === 'administrator') {
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
