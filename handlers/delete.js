module.exports = async (ctx) => {
  const chatMember = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id)

  ctx.deleteMessage(ctx.message.message_id).catch((error) => {
    ctx.replyWithHTML(ctx.i18n.t('del.error', {
      error,
    }))
  })
  if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
    if (ctx.message.reply_to_message) {
      ctx.deleteMessage(ctx.message.reply_to_message.message_id)
    }
  }
}
