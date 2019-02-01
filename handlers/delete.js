module.exports = async (ctx) => {
  const chatMember = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id)

  ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch((error) => {
    ctx.replyWithHTML(ctx.i18n.t('del.error', {
      error,
    }))
  })
  if (chatMember.status === 'creator' || chatMember.status === 'administrator') {
    if (ctx.message.reply_to_message) {
      ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.reply_to_message.message_id)
    }
  }
}
