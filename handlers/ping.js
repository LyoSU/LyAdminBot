module.exports = async (ctx) => {
  const sms = new Date() - ctx.ms
  const message = await ctx.replyWithHTML('Pong')
  const tms = new Date() - ctx.ms - sms
  ctx.telegram.editMessageText(message.chat.id, message.message_id, null,
    ctx.i18n.t('cmd.ping', {sms: sms, tms: tms})
  )
}