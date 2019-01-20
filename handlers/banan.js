const humanizeDuration = require('humanize-duration')
const { userName, getRandomInt } = require('../lib')


module.exports = async (ctx) => {
  ctx.mixpanel.track('banan')
  const arg = ctx.message.text.split(/ +/)
  const chatMember = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id)
  let banTime
  let banType
  let banUser
  let banTimeArr

  if (chatMember.status === 'creator' || chatMember.status === 'administrator') {
    if (ctx.message.reply_to_message) {
      banUser = ctx.message.reply_to_message.from

      if (arg[1]) {
        banTimeArr = { m: 60, h: 3600, d: 86400 }
        banType = arg[1].slice(-1)

        if (!banTimeArr[banType]) {
          banType = 'm'
        }
        banTime = parseInt(arg[1], 10) * banTimeArr[banType]
      }
      else {
        const replyMember = await ctx.telegram.getChatMember(
          ctx.message.chat.id,
          ctx.message.reply_to_message.from.id
        )

        if (replyMember.status === 'restricted') {
          banTime = -1
          ctx.groupMemberInfo.banan.sum -= (
            ctx.groupMemberInfo.banan.last.how - (
              ctx.message.date - ctx.groupMemberInfo.banan.last.time
            )
          )
        }
        else {
          banTime = 300 * (ctx.groupMemberInfo.banan.stack + 1)
          ctx.groupMemberInfo.banan.stack += 1
        }
      }
    }
  }
  else {
    banUser = ctx.from
    banTime = getRandomInt(60, 600)
  }

  if (banTime) {
    if (banTime > 0) {
      const unixBanTime = ctx.message.date + banTime
      const banDuration = humanizeDuration(
        banTime * 1000,
        { language: ctx.i18n.locale() }
      )

      await ctx.telegram.restrictChatMember(
        ctx.chat.id,
        banUser.id,
        { until_date: unixBanTime }
      )
        .then(() => {
          ctx.replyWithHTML(ctx.i18n.t('banan.suc', {
            name: userName(banUser, true),
            duration: banDuration,
          }))
          ctx.groupMemberInfo.banan.num += 1
          ctx.groupMemberInfo.banan.sum += banTime
          ctx.groupMemberInfo.banan.last = {
            who: ctx.from.id,
            how: banTime,
            time: ctx.message.date,
          }
        })
        .catch((error) => {
          ctx.replyWithHTML(ctx.i18n.t('banan.error', {
            error,
          }))
        })
    }
    else {
      await ctx.telegram.restrictChatMember(ctx.chat.id, banUser.id, {
        until_date: ctx.message.date,
        can_send_messages: true,
        can_send_other_messages: true,
        can_send_media_messages: true,
        can_add_web_page_previews: true,
      }).then(() => {
        ctx.replyWithHTML(ctx.i18n.t('banan.pick', {
          name: userName(banUser, true),
        }))
      })
    }
    ctx.groupInfo.save()
  }
  else {
    ctx.replyWithHTML(ctx.i18n.t('banan.show', {
      name: userName(ctx.from, true),
    }))
  }
}
