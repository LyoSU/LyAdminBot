const User = require('../models/user')
const { userName } = require('../utils')


module.exports = async (ctx) => {

  let topMembers = []

  ctx.groupInfo.members.forEach((member) => {
    const active = ((member.stats.textTotal * 100) / ctx.groupInfo.stats.textTotal).toFixed(2)

    topMembers.push({
      telegram_id: member.telegram_id,
      active,
    })
  })

  if (topMembers.length > 0) {
    topMembers.sort((a, b) => b.active - a.active)

    let top = ''

    topMembers = topMembers.slice(0, 10)

    for (let index = 0; index < topMembers.length; index++) {
      const user = await User.findOne({ telegram_id: topMembers[index].telegram_id })

      top += `\n${userName(user)} — ${topMembers[index].active}%`
    }

    ctx.replyWithHTML(ctx.i18n.t('cmd.top.info', {
      chatName: ctx.chat.title,
      top,
    }), {
      reply_to_message_id: ctx.message.message_id,
    })
  }
}
