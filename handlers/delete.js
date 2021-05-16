module.exports = async (ctx) => {
  const chatMember = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id)

  await ctx.deleteMessage(ctx.message.message_id).catch((error) => {
    return ctx.replyWithHTML(ctx.i18n.t('del.error', {
      error
    }))
  })
  if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
    if (ctx.message.reply_to_message) {
      await ctx.deleteMessage(ctx.message.reply_to_message.message_id)
    }
  }
}
