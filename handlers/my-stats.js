const humanizeDuration = require('humanize-duration')
const dateFormat = require('dateformat')
const { userName } = require('../utils')
const { scheduleDeletion } = require('../helpers/message-cleanup')

/**
 * Get a fun badge based on user stats
 */
function getStatsBadge (ctx, member, active, flood, messages, banCount) {
  // Veteran: here for > 6 months
  const memberAge = Date.now() - new Date(member.createdAt).getTime()
  const sixMonths = 6 * 30 * 24 * 60 * 60 * 1000

  // Exemplary citizen: many messages, no bans
  if (messages > 100 && banCount === 0) {
    return ctx.i18n.t('cmd.my_stats.badge.exemplary')
  }

  // Banana collector: 10+ bans
  if (banCount >= 10) {
    return ctx.i18n.t('cmd.my_stats.badge.collector')
  }

  // Soul of the party: > 15% activity
  if (parseFloat(active) > 15) {
    return ctx.i18n.t('cmd.my_stats.badge.soul')
  }

  // Flood master: > 150% flood
  if (parseFloat(flood) > 150) {
    return ctx.i18n.t('cmd.my_stats.badge.flood_master')
  }

  // Veteran: > 6 months
  if (memberAge > sixMonths && messages > 50) {
    return ctx.i18n.t('cmd.my_stats.badge.veteran')
  }

  // Silent observer: < 1% activity but old member
  if (parseFloat(active) < 1 && memberAge > 30 * 24 * 60 * 60 * 1000) {
    return ctx.i18n.t('cmd.my_stats.badge.silent')
  }

  // Newbie: < 7 days
  if (memberAge < 7 * 24 * 60 * 60 * 1000) {
    return ctx.i18n.t('cmd.my_stats.badge.newbie')
  }

  return ''
}

module.exports = async (ctx) => {
  if (['supergroup', 'group'].includes(ctx.chat.type)) {
    const member = ctx.group.members[ctx.from.id]
    const groupAvrg = ctx.group.info.stats.textTotal / ctx.group.info.stats.messagesCount
    const memberAvrg = member.stats.textTotal / member.stats.messagesCount

    const active = ((member.stats.textTotal * 100) / ctx.group.info.stats.textTotal).toFixed(2)
    const flood = Math.abs(((memberAvrg - groupAvrg) / groupAvrg) * 100).toFixed(2)
    const messages = member.stats.messagesCount
    const banCount = member.banan.num

    // Get fun badge
    const badge = getStatsBadge(ctx, member, active, flood, messages, banCount)

    const pMessage = await ctx.telegram.sendMessage(ctx.from.id, ctx.i18n.t('cmd.my_stats.chat', {
      name: userName(ctx.from, true),
      chatName: ctx.chat.title,
      banTime: humanizeDuration(
        member.banan.sum * 1000,
        { language: ctx.i18n.locale(), fallbacks: ['en'] }
      ),
      banAutoTime: humanizeDuration(
        member.banan.stack * ctx.group.info.settings.banan.default * 1000,
        { language: ctx.i18n.locale(), fallbacks: ['en'] }
      ),
      banCount,
      messages,
      active,
      flood,
      createdAt: dateFormat(member.createdAt, 'dd.mm.yyyy H:MM:ss'),
      badge
    }), {
      parse_mode: 'HTML'
    }).catch(() => {})

    let gMessage

    if (pMessage) {
      gMessage = await ctx.replyWithHTML(ctx.i18n.t('cmd.my_stats.send_pm'), {
        reply_to_message_id: ctx.message.message_id
      })
    } else {
      gMessage = await ctx.replyWithHTML(ctx.i18n.t('cmd.my_stats.error.blocked'), {
        reply_to_message_id: ctx.message.message_id
      })
    }

    if (gMessage && ctx.db) {
      const delayMs = 3 * 1000
      // Delete bot's response
      scheduleDeletion(ctx.db, {
        chatId: ctx.chat.id,
        messageId: gMessage.message_id,
        delayMs,
        source: 'cmd_stats'
      }, ctx.telegram)
      // Delete user's command
      scheduleDeletion(ctx.db, {
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        delayMs,
        source: 'cmd_stats'
      }, ctx.telegram)
    }
  }
}
