module.exports = async (ctx) => {
  const message = await ctx.replyWithHTML('Pong')
  const ms = new Date() - ctx.ms
  ctx.telegram.editMessageText(message.chat.id, message.message_id, null,
    ctx.i18n.t('cmd.ping', {ms: ms})
  )
}