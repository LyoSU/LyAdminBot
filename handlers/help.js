module.exports = async (ctx) => {
  const message = await ctx.replyWithHTML(ctx.i18n.t('cmd.help'), {
    reply_to_message_id: ctx.message.message_id
  })

  if (['supergroup', 'group'].includes(ctx.chat.type)) {
    setTimeout(() => {
      ctx.deleteMessage(message.message_id)
      ctx.deleteMessage()
    }, 60 * 1000)
  }
}
