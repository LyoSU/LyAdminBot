module.exports = async (ctx) => {
  const message = await ctx.replyWithHTML('pong')
  const ms = new Date() - ctx.msStart
  ctx.telegram.editMessageText(message.chat.id, message.message_id, null,
    ctx.i18n.t('cmd.ping', {ms: ms})
  )
}