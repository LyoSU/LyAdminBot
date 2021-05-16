const humanizeDuration = require('humanize-duration')
const dateFormat = require('dateformat')
const { userName } = require('../utils')


module.exports = async (ctx) => {
  if (['supergroup', 'group'].includes(ctx.chat.type)) {
    const groupAvrg = ctx.group.info.stats.textTotal / ctx.group.info.stats.messagesCount
    const memberAvrg = ctx.group.members[ctx.from.id].stats.textTotal / ctx.group.members[ctx.from.id].stats.messagesCount

    const active = ((ctx.group.members[ctx.from.id].stats.textTotal * 100) / ctx.group.info.stats.textTotal).toFixed(2)
    const flood = Math.abs(((memberAvrg - groupAvrg) / groupAvrg) * 100).toFixed(2)

    const pMessage = await ctx.telegram.sendMessage(ctx.from.id, ctx.i18n.t('cmd.my_stats.chat', {
      name: userName(ctx.from, true),
      chatName: ctx.chat.title,
      banTime: humanizeDuration(
        ctx.group.members[ctx.from.id].banan.sum * 1000,
        { language: ctx.i18n.locale(), fallbacks: ['en'] }
      ),
      banAutoTime: humanizeDuration(
        ctx.group.members[ctx.from.id].banan.stack * ctx.group.info.settings.banan.default * 1000,
        { language: ctx.i18n.locale(), fallbacks: ['en'] }
      ),
      banCount: ctx.group.members[ctx.from.id].banan.num,
      messages: ctx.group.members[ctx.from.id].stats.messagesCount,
      active,
      flood,
      createdAt: dateFormat(ctx.group.members[ctx.from.id].createdAt, 'dd.mm.yyyy H:MM:ss'),
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
        await ctx.deleteMessage(gMessage.message_id)
        await ctx.deleteMessage()
      }, 3 * 1000)
    }
  }
}
