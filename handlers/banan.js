const humanizeDuration = require('humanize-duration')
const { userName, getRandomInt } = require('../utils')
const { mapTelegramError } = require('../helpers/error-mapper')
const { scheduleDeletion } = require('../helpers/message-cleanup')

/**
 * Get easter egg key based on ban context
 */
function getEasterEggKey (ctx, banTime, banUser, banMember) {
  const isSelfBan = ctx.from.id === banUser.id
  const selfBanCount = banMember?.banan?.num || 0

  // 69 or 420 easter eggs
  if (banTime === 69 || banTime === 69 * 60) return 'banan.easter.nice'
  if (banTime === 420 || banTime === 420 * 60) return 'banan.easter.blaze'

  // Huge ban (> 7 days)
  if (banTime > 7 * 24 * 60 * 60) return 'banan.easter.huge'

  // Exactly 60 seconds
  if (banTime === 60) return 'banan.easter.minute_exact'

  // Self-ban variants
  if (isSelfBan) {
    if (selfBanCount >= 5) return 'banan.easter.self_legend'
    if (selfBanCount >= 2) return 'banan.easter.self_again'
    return 'banan.easter.self'
  }

  // First ban after many messages (> 100)
  if (banMember && banMember.banan.num === 0 && banMember.stats?.textTotal > 100) {
    return 'banan.easter.first_after_many'
  }

  // Round number bans (10, 25, 50, 100...)
  const roundNumbers = [10, 25, 50, 100, 200, 500, 1000]
  if (banMember && roundNumbers.includes(banMember.banan.num + 1)) {
    return 'banan.easter.round_number'
  }

  return null // No easter egg
}

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
    if (!ctx.group.members[banUser.id]) {
      ctx.group.members[banUser.id] = await ctx.db.GroupMember.findOne({
        group: ctx.group.info,
        telegram_id: banUser.id
      })
    }
    const banMember = ctx.group.members[banUser.id]

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
      if (ctx.message.reply_to_message && ctx.message.reply_to_message.sender_chat) {
        await ctx.tg.callApi('banChatSenderChat', {
          chat_id: ctx.chat.id,
          sender_chat_id: ctx.message.reply_to_message.sender_chat.id,
          until_date: banTime
        })

        await ctx.replyWithHTML(ctx.i18n.t('banan.suc', {
          name: userName(banUser, true),
          duration: banDuration
        }))

        return
      }

      await ctx.telegram.restrictChatMember(
        ctx.chat.id,
        banUser.id,
        { until_date: unixBanTime }
      ).then(async () => {
        if (banUser.id === 686968130) {
          await ctx.replyWithDocument({
            source: 'assets/arkasha_banan.webp'
          }, {
            reply_to_message_id: ctx.message.message_id
          })
        }

        // Check for easter egg
        const easterKey = getEasterEggKey(ctx, banTime, banUser, banMember)
        const msgKey = easterKey || 'banan.suc'
        const msgParams = {
          name: userName(banUser, true),
          duration: banDuration,
          count: (banMember?.banan?.num || 0) + 1
        }

        const message = await ctx.replyWithHTML(ctx.i18n.t(msgKey, msgParams))

        // const replyBanMember = await ctx.telegram.getChatMember(
        //   ctx.message.chat.id,
        //   banUser.id
        // )

        // if (replyBanMember.status === 'restricted' && (banMember.banan.last.time + banMember.banan.last.how) > 0) {
        //   banMember.banan.sum -= (
        //     banMember.banan.last.how - (
        //       ctx.message.date - banMember.banan.last.time
        //     )
        //   )
        // }

        banMember.banan.num += 1
        banMember.banan.sum += banTime
        banMember.banan.last = {
          who: ctx.from.id,
          how: banTime,
          time: ctx.message.date
        }
        if (autoBan) banMember.banan.stack += 1

        if (ctx.from.id === banUser.id && ctx.db) {
          const delayMs = 15 * 1000
          // Delete bot's response
          scheduleDeletion(ctx.db, {
            chatId: ctx.chat.id,
            messageId: message.message_id,
            delayMs,
            source: 'cmd_banan'
          }, ctx.telegram)
          // Delete user's command
          scheduleDeletion(ctx.db, {
            chatId: ctx.chat.id,
            messageId: ctx.message.message_id,
            delayMs,
            source: 'cmd_banan'
          }, ctx.telegram)
        }
      }).catch((error) => {
        const errorKey = mapTelegramError(error, 'banan')
        ctx.replyWithHTML(ctx.i18n.t(errorKey))
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
    // Self-show - check for easter egg variant
    let showKey = 'banan.show'
    if (ctx.group?.members?.[ctx.from.id]) {
      const member = ctx.group.members[ctx.from.id]
      const selfCount = member?.banan?.num || 0
      if (selfCount >= 5) showKey = 'banan.easter.self_legend'
      else if (selfCount >= 2) showKey = 'banan.easter.self_again'
    }

    await ctx.replyWithHTML(ctx.i18n.t(showKey, {
      name: userName(ctx.from, true)
    }))
  }
}
