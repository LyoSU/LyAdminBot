const humanizeDuration = require('humanize-duration')
const dateFormat = require('dateformat')
const { userName } = require('../utils')


module.exports = async (ctx) => {
  if (['supergroup', 'group'].includes(ctx.chat.type)) {
    const groupAvrg = ctx.group.info.stats.textTotal / ctx.group.info.stats.messagesCount
    const memberAvrg = ctx.group.member.stats.textTotal / ctx.group.member.stats.messagesCount

    const active = ((ctx.group.member.stats.textTotal * 100) / ctx.group.info.stats.textTotal).toFixed(2)
    const flood = Math.abs(((memberAvrg - groupAvrg) / groupAvrg) * 100).toFixed(2)

    const pMessage = await ctx.telegram.sendMessage(ctx.from.id, ctx.i18n.t('cmd.my_stats.chat', {
      name: userName(ctx.from, true),
      chatName: ctx.chat.title,
      banTime: humanizeDuration(
        ctx.group.member.banan.sum * 1000,
        { language: ctx.i18n.locale() }
      ),
      banAutoTime: humanizeDuration(
        ctx.group.member.banan.stack * ctx.group.info.settings.banan.default * 1000,
        { language: ctx.i18n.locale() }
      ),
      banCount: ctx.group.member.banan.num,
      messages: ctx.group.member.stats.messagesCount,
      active,
      flood,
      createdAt: dateFormat(ctx.group.member.createdAt, 'dd.mm.yyyy H:MM:ss'),
    }), {
      parse_mode: 'HTML',
    }).catch(() => {})

    let gMessage

    if (pMessage) {
      gMessage = await ctx.replyWithHTML(ctx.i18n.t('cmd.my_stats.send_pm'), {
        reply_to_message_id: ctx.message.message_id,
      })
    }
    else {
      gMessage = await ctx.replyWithHTML(ctx.i18n.t('cmd.my_stats.error.blocked'), {
        reply_to_message_id: ctx.message.message_id,
      })
    }

    if (gMessage) {
      setTimeout(() => {
        ctx.deleteMessage(gMessage.message_id)
        ctx.deleteMessage()
      }, 3 * 1000)
    }
  }
}
