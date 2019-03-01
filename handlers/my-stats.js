const humanizeDuration = require('humanize-duration')
const dateFormat = require('dateformat')
const { userName } = require('../utils')


module.exports = async (ctx) => {
  ctx.replyWithHTML(ctx.i18n.t('cmd.my_stats.chat', {
    name: userName(ctx.from, true),
    chatName: ctx.chat.title,
    banTime: humanizeDuration(
      ctx.groupMemberInfo.banan.sum * 1000,
      { language: ctx.i18n.locale() }
    ),
    banCount: ctx.groupMemberInfo.banan.num,
    createdAt: dateFormat(ctx.groupMemberInfo.createdAt, 'dd.mm.yyyy H:MM:ss'),
  }))
}
