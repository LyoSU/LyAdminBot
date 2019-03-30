const humanizeDuration = require('humanize-duration')
const dateFormat = require('dateformat')
const { userName } = require('../utils')


module.exports = async (ctx) => {
  if (['supergroup', 'group'].includes(ctx.chat.type)) {
    const message = await ctx.replyWithHTML(ctx.i18n.t('cmd.my_stats.send_pm'), {
      reply_to_message_id: ctx.message.message_id,
    })

    ctx.telegram.sendMessage(ctx.from.id, ctx.i18n.t('cmd.my_stats.chat', {
      name: userName(ctx.from, true),
      chatName: ctx.chat.title,
      banTime: humanizeDuration(
        ctx.groupMemberInfo.banan.sum * 1000,
        { language: ctx.i18n.locale() }
      ),
      banCount: ctx.groupMemberInfo.banan.num,
      createdAt: dateFormat(ctx.groupMemberInfo.createdAt, 'dd.mm.yyyy H:MM:ss'),
    }), {
      parse_mode: 'HTML',
    })

    setTimeout(() => {
      ctx.deleteMessage(message.message_id)
      ctx.deleteMessage()
    }, 3 * 1000)
  }
}
