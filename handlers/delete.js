module.exports = async (ctx) => {
  ctx.mixpanel.track('del')
  await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id).then((result) => chatStatus = result.status)

  if (chatStatus === 'creator' || chatStatus === 'administrator') {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id)
    if (ctx.message.reply_to_message.message_id) ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.reply_to_message.message_id)
  } else {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id)
  }
}