const humanizeDuration = require('humanize-duration')
const { userName, getRandomInt } = require('../utils')

module.exports = async (ctx) => {
  const arg = ctx.message.text.split(/ +/)
  const chatMember = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id)
  const banTimeArr = { m: 60, h: 3600, d: 86400 }
  let banTime = getRandomInt(60, 600)
  let banType = 'm'
  let banUser = ctx.from
  let autoBan = false

  if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
    if (ctx.message.reply_to_message) {
      banUser = ctx.message.reply_to_message.from

      if (parseInt(arg[1], 10) > 0) {
        banType = arg[1].slice(-1)

        if (!banTimeArr[banType]) {
          banType = 'm'
        }
        banTime = parseInt(arg[1], 10) * banTimeArr[banType]
      } else {
        const replyMember = await ctx.telegram.getChatMember(
          ctx.message.chat.id,
          ctx.message.reply_to_message.from.id
        )

        if (replyMember.status === 'restricted') {
          banTime = -1
        } else {
          banTime = ctx.group.info.settings.banan.default
          autoBan = true
        }
      }
    } else {
      banTime = null
    }
  }

  if (banTime) {
    const banMember = await ctx.db.GroupMember.findOne({
      group: ctx.group.info,
      telegram_id: banUser.id
    })

    if (autoBan) banTime *= (banMember.banan.stack + 1)

    if (banTime > 0) {
      const now = Math.floor(Date.now() / 1000)

      const maxBanTime = 364 * 24 * 60 * 60
      const minBanTime = 60

      if (banTime > maxBanTime) banTime = maxBanTime
      if (banTime < minBanTime) banTime = minBanTime

      const unixBanTime = now + banTime

      const banDuration = humanizeDuration(
        banTime * 1000,
        { language: ctx.i18n.locale(), fallbacks: ['en'] }
      )

      await ctx.telegram.restrictChatMember(
        ctx.chat.id,
        banUser.id,
        { until_date: unixBanTime }
      ).then(async () => {
        if (banUser.id === 686968130) {
          ctx.replyWithDocument({
            source: 'assets/arkasha_banan.webp'
          }, {
            reply_to_message_id: ctx.message.message_id
          })
        }

        const message = await ctx.replyWithHTML(ctx.i18n.t('banan.suc', {
          name: userName(banUser, true),
          duration: banDuration
        }))

        const replyBanMember = await ctx.telegram.getChatMember(
          ctx.message.chat.id,
          banUser.id
        )

        if (replyBanMember.status === 'restricted' && (banMember.banan.last.time + banMember.banan.last.how) > 0) {
          banMember.banan.sum -= (
            banMember.banan.last.how - (
              ctx.message.date - banMember.banan.last.time
            )
          )
        }

        banMember.banan.num += 1
        banMember.banan.sum += banTime
        banMember.banan.last = {
          who: ctx.from.id,
          how: banTime,
          time: ctx.message.date
        }
        if (autoBan) banMember.banan.stack += 1

        if (ctx.from.id === banUser.id) {
          setTimeout(() => {
            ctx.deleteMessage(message.message_id)
            ctx.deleteMessage()
          }, 15 * 1000)
        }
      }).catch((error) => {
        ctx.replyWithHTML(ctx.i18n.t('banan.error', {
          error
        }))
      })
    } else {
      await ctx.telegram.restrictChatMember(ctx.chat.id, banUser.id, {
        until_date: ctx.message.date,
        can_send_messages: true,
        can_send_other_messages: true,
        can_send_media_messages: true,
        can_add_web_page_previews: true
      }).then(() => {
        ctx.replyWithHTML(ctx.i18n.t('banan.pick', {
          name: userName(banUser, true)
        }))

        banMember.banan.sum -= (
          banMember.banan.last.how - (
            ctx.message.date - banMember.banan.last.time
          )
        )
      })
    }

    banMember.banan.time = Date.now()
    await banMember.save()
  } else {
    await ctx.replyWithHTML(ctx.i18n.t('banan.show', {
      name: userName(ctx.from, true)
    }))
  }
}
