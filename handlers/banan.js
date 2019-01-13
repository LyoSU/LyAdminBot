const humanizeDuration = require('humanize-duration')
const { userLogin, getRandomInt } = require('../lib')

module.exports = async (ctx) => {
  ctx.mixpanel.track('banan')
  var arg = ctx.message.text.split(/ +/)
  const chatMember = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id)

  if (chatMember.status === 'creator' || chatMember.status === 'administrator') {
    if (ctx.message.reply_to_message) {
      var banUser = ctx.message.reply_to_message.from
      if (arg[1]) {
        const banTimeArr = { 'm': 60, 'h': 3600, 'd': 86400 }
        var banType = arg[1].slice(-1)
        if (!banTimeArr[banType]) var banType = 'm'
        var banTime = parseInt(arg[1]) * banTimeArr[banType]
      } else {
        const replyMember = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.reply_to_message.from.id)
        if (replyMember.status === 'restricted') {
          var banTime = -1
        } else {
          var banTime = 300
        }
      }
    }
  } else {
    var banUser = ctx.from
    var banTime = getRandomInt(60, 600)
  }

  if (banTime) {
    if (banTime > 0) {
      var unixBanTime = ctx.message.date + banTime
      var banDuration = humanizeDuration(banTime * 1000, { language: ctx.i18n.locale() })

      ctx.telegram.restrictChatMember(ctx.chat.id, banUser.id, { until_date: unixBanTime }).then(() => {
        ctx.replyWithHTML(
          ctx.i18n.t('banan.suc', {
            login: userLogin(banUser, true),
            duration: banDuration
          })
        )
      }).catch((error) => {
        ctx.replyWithHTML(
          ctx.i18n.t('banan.error', {
            error: error
          })
        )
      })
    } else {
      ctx.telegram.restrictChatMember(ctx.chat.id, banUser.id, {
        'until_date': ctx.message.date,
        'can_send_messages': true,
        'can_send_other_messages': true,
        'can_send_media_messages': true,
        'can_add_web_page_previews': true
      }).then(() => {
        ctx.replyWithHTML(
          ctx.i18n.t('banan.pick', {
            login: userLogin(banUser, true)
          })
        )
      })
    }
  } else {
    ctx.replyWithHTML(
      ctx.i18n.t('banan.show', {
        login: userLogin(ctx.from, true)
      })
    )
  }
}
