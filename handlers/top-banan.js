const humanizeDuration = require('humanize-duration')
const { userName } = require('../utils')


module.exports = async (ctx) => {
  let result = ''
  let topMembers = []

  const groupMembers = await ctx.db.GroupMember.find({ group: ctx.group.info })

  groupMembers.forEach((member) => {
    if (member.banan.num > 0 || member.banan.sum > 0) {
      topMembers.push({
        telegram_id: member.telegram_id,
        banan: {
          num: member.banan.num,
          sum: member.banan.sum,
        }
      })
    }
  })

  if (topMembers.length > 0) {
    topMembers.sort((a, b) => b.banan.sum - a.banan.sum)

    let top = ''

    topMembersSum = topMembers.slice(0, 10)

    for (let index = 0; index < topMembersSum.length; index++) {
      const user = await ctx.db.User.findOne({ telegram_id: topMembersSum[index].telegram_id })
      const banan = humanizeDuration(
        topMembersSum[index].banan.sum * 1000,
        {
          round: true,
          largest: 2,
          language: ctx.i18n.locale(),
          fallbacks: ['en'],
        }
      )

      top += `\n${index+1}. ${userName(user)} — ${banan}`
    }

    topMembers.sort((a, b) => b.banan.num - a.banan.num)

    top += '\n'

    topMembersNum = topMembers.slice(0, 10)

    for (let index = 0; index < topMembersNum.length; index++) {
      const user = await ctx.db.User.findOne({ telegram_id: topMembersNum[index].telegram_id })
      const banan = topMembersNum[index].banan.num

      top += `\n${index+1}. ${userName(user)} — ${banan} 🍌`
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
