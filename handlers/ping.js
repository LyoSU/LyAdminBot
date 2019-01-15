const humanizeDuration = require('humanize-duration')

module.exports = async (ctx) => {
  let sms = new Date() - ctx.ms
  const message = await ctx.replyWithHTML('Pong')
  let tms = new Date() - ctx.ms - sms
  let workTime = humanizeDuration(new Date() - global.botStart, { language: ctx.i18n.locale(), round: true })
  ctx.telegram.editMessageText(message.chat.id, message.message_id, null,
    ctx.i18n.t('cmd.ping', { sms: sms, tms: tms, workTime: workTime }),
    { parse_mode: 'HTML' }
  )
}