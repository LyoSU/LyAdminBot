const humanizeDuration = require('humanize-duration')


module.exports = async (ctx) => {
  const sms = new Date() - ctx.ms
  const dt = (new Date() / 1000) - ctx.message.date
  let delay = ''

  if (dt > 2) {
    const delayTime = humanizeDuration(dt * 1000, { language: ctx.i18n.locale(), fallbacks: ['en'], round: true })

    delay = ctx.i18n.t('cmd.ping.delay', { delayTime })
  }

  const message = await ctx.replyWithHTML('Pong', {
    reply_to_message_id: ctx.message.message_id,
  })
  const tms = new Date() - ctx.ms - sms
  const workTime = humanizeDuration(
    new Date() - global.startDate,
    { language: ctx.i18n.locale(), fallbacks: ['en'], round: true }
  )

  ctx.telegram.editMessageText(
    message.chat.id, message.message_id, null,
    ctx.i18n.t('cmd.ping.pong', { sms, tms, workTime, delay }),
    { parse_mode: 'HTML' }
  )

  setTimeout(() => {
    ctx.deleteMessage(message.message_id)
    ctx.deleteMessage()
  }, 5 * 1000)
}
