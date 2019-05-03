const humanizeDuration = require('humanize-duration')


module.exports = async (ctx) => {

  let memberList = ''

  ctx.groupInfo.members.forEach((member) => {
    const groupAvrg = ctx.groupInfo.stats.textTotal / ctx.groupInfo.stats.messagesCount
    const memberAvrg = member.stats.textTotal / member.stats.messagesCount

    const active = ((member.stats.textTotal * 100) / ctx.groupInfo.stats.textTotal).toFixed(2)
    const flood = Math.abs(((memberAvrg - groupAvrg) / groupAvrg) * 100).toFixed(2)

    memberList += ctx.i18n.t('cmd.members.member', {
      telegram_id: member.telegram_id,
      banTime: humanizeDuration(
        ctx.groupMemberInfo.banan.sum * 1000,
        {
          language: 'shortEn',
          languages: {
            shortEn: {
              y: () => 'y',
              mo: () => 'mo',
              w: () => 'w',
              d: () => 'd',
              h: () => 'h',
              m: () => 'm',
              s: () => 's',
              ms: () => 'ms',
            },
          },
          largest: 2,
        }
      ),
      active,
      flood,
    })
  })

  ctx.deleteMessage()

  ctx.telegram.sendMessage(ctx.from.id, memberList, {
    parse_mode: 'HTML',
  })
}
