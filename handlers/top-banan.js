const humanizeDuration = require('humanize-duration')
const { userName } = require('../utils')


module.exports = async (ctx) => {
  let result = ''
  let topMembers = []

  ctx.groupInfo.members.forEach((member) => {
    if (member.banan.sum > 0) {
      topMembers.push({
        telegram_id: member.telegram_id,
        banan: member.banan.sum,
      })
    }
  })

  if (topMembers.length > 0) {
    topMembers.sort((a, b) => b.banan - a.banan)

    let top = ''

    topMembers = topMembers.slice(0, 10)

    for (let index = 0; index < topMembers.length; index++) {
      const user = await ctx.db.User.findOne({ telegram_id: topMembers[index].telegram_id })
      const banan = humanizeDuration(
        topMembers[index].banan * 1000,
        {
          round: true,
          largest: 2,
          language: ctx.i18n.locale(),
        }
      )

      top += `\n${userName(user)} — ${banan}`
    }

    result = ctx.i18n.t('cmd.top_banan.info', {
      chatName: ctx.chat.title,
      top,
    })
  }
  else {
    result = ctx.i18n.t('cmd.top_banan.error.empty')
  }

  ctx.replyWithHTML(result, {
    reply_to_message_id: ctx.message.message_id,
  })
}
