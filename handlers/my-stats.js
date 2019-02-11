const humanizeDuration = require('humanize-duration')
const dateFormat = require('dateformat')
const { userName } = require('../lib')

// eslint-disable-next-line padded-blocks
module.exports = async (ctx) => {

  ctx.replyWithHTML(ctx.i18n.t('cmd.my_stats.chat', {
    name: userName(ctx.from, true),
    chatName: ctx.chat.title,
    banTime: humanizeDuration(
      ctx.groupMemberInfo.banan.sum,
      { language: ctx.i18n.locale() }
    ),
    banCount: ctx.groupMemberInfo.banan.num,
    firstAct: dateFormat(ctx.groupMemberInfo.first_act * 1000, 'dd.mm.yyyy h:MM:ss'),
  }))
}
