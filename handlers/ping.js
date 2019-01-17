const humanizeDuration = require('humanize-duration')


module.exports = async (ctx) => {
  const sms = new Date() - ctx.ms
  const message = await ctx.replyWithHTML('Pong')
  const tms = new Date() - ctx.ms - sms
  const workTime = humanizeDuration(
    new Date() - global.botStart,
    { language: ctx.i18n.locale(), round: true }
  )

  ctx.telegram.editMessageText(
    message.chat.id, message.message_id, null,
    ctx.i18n.t('cmd.ping', { sms, tms, workTime }),
    { parse_mode: 'HTML' }
  )
}
