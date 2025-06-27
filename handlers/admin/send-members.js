const humanizeDuration = require('humanize-duration')

module.exports = async (ctx) => {
  await ctx.deleteMessage()

  const { members } = ctx.group.info
  const maxUser = 100
  let memberList = ''
  let messages = 1

  for (let index = 0; index < members.length; index++) {
    const member = members[index]

    const groupAvrg = ctx.group.info.stats.textTotal / ctx.group.info.stats.messagesCount
    const memberAvrg = member.stats.textTotal / member.stats.messagesCount

    const active = ((member.stats.textTotal * 100) / ctx.group.info.stats.textTotal).toFixed(2)
    const flood = Math.abs(((memberAvrg - groupAvrg) / groupAvrg) * 100).toFixed(2)

    memberList += ctx.i18n.t('cmd.members.member', {
      telegram_id: member.telegram_id,
      banTime: humanizeDuration(
        member.banan.sum * 1000,
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
              ms: () => 'ms'
            }
          },
          largest: 2
        }
      ),
      active,
      flood
    })

    if (index > maxUser * messages || members.length === index + 1) {
      messages++
      ctx.telegram.sendMessage(ctx.from.id, memberList, {
        parse_mode: 'HTML'
      })
      memberList = ''
    }
  }
}
