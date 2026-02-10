const humanizeDuration = require('humanize-duration')
const { userName, getRandomInt } = require('../utils')
const { mapTelegramError } = require('../helpers/error-mapper')
const { scheduleDeletion } = require('../helpers/message-cleanup')

const BAN_UNITS = { m: 60, h: 3600, d: 86400 }
const MAX_BAN = 364 * 24 * 60 * 60
const MIN_BAN = 60
const SELF_BAN_CLEANUP_DELAY = 15 * 1000

/**
 * Get easter egg i18n key based on ban context.
 * Returns null for normal ban message.
 */
function getEasterEggKey (banTime, isSelfBan, banMember) {
  if (banTime === 69 || banTime === 69 * 60) return 'banan.easter.nice'
  if (banTime === 420 || banTime === 420 * 60) return 'banan.easter.blaze'
  if (banTime > 7 * 24 * 60 * 60) return 'banan.easter.huge'
  if (banTime === 60) return 'banan.easter.minute_exact'

  if (isSelfBan && Math.random() < 0.3) {
    const count = banMember?.banan?.num || 0
    if (count >= 5) return 'banan.easter.self_legend'
    if (count >= 2) return 'banan.easter.self_again'
    return 'banan.easter.self'
  }

  if (banMember?.banan?.num === 0 && banMember.stats?.textTotal > 100) {
    return 'banan.easter.first_after_many'
  }

  const milestones = [10, 25, 50, 100, 200, 500, 1000]
  if (banMember && milestones.includes(banMember.banan.num + 1)) {
    return 'banan.easter.round_number'
  }

  return null
}

function clampBanTime (seconds) {
  return Math.max(MIN_BAN, Math.min(MAX_BAN, seconds))
}

function formatDuration (seconds, ctx) {
  return humanizeDuration(seconds * 1000, {
    language: ctx.i18n.locale(),
    fallbacks: ['en']
  })
}

async function ensureBanMember (ctx, userId) {
  if (!ctx.group.members[userId]) {
    ctx.group.members[userId] = await ctx.db.GroupMember.findOne({
      group: ctx.group.info,
      telegram_id: userId
    })
  }
  return ctx.group.members[userId]
}

/**
 * Ban a sender_chat (channel) — separate flow from user bans.
 */
async function banSenderChat (ctx, replySenderChat, unixBanTime, banDuration, banUser) {
  const linkedChatId = ctx.group?.info?.linked_chat_id

  if (ctx.message.reply_to_message.is_automatic_forward ||
      (linkedChatId && replySenderChat.id === linkedChatId)) {
    return ctx.replyWithHTML(ctx.i18n.t('banan.cant_ban_linked_channel'))
  }

  await ctx.tg.callApi('banChatSenderChat', {
    chat_id: ctx.chat.id,
    sender_chat_id: replySenderChat.id,
    until_date: unixBanTime
  })

  await ctx.replyWithHTML(ctx.i18n.t('banan.suc', {
    name: userName(banUser, true),
    duration: banDuration
  }))
}

/**
 * Schedule cleanup of self-ban command and response messages.
 */
function scheduleSelBanCleanup (ctx, responseMessageId) {
  if (!ctx.db) return
  scheduleDeletion(ctx.db, {
    chatId: ctx.chat.id,
    messageId: responseMessageId,
    delayMs: SELF_BAN_CLEANUP_DELAY,
    source: 'cmd_banan'
  }, ctx.telegram)
  scheduleDeletion(ctx.db, {
    chatId: ctx.chat.id,
    messageId: ctx.message.message_id,
    delayMs: SELF_BAN_CLEANUP_DELAY,
    source: 'cmd_banan'
  }, ctx.telegram)
}

/**
 * Parse ban time from admin command arguments.
 * Returns { banTime, banUser, autoBan } or null for show-stats.
 */
async function parseAdminBan (ctx, arg) {
  const banUser = ctx.message.reply_to_message.from

  if (parseInt(arg[1], 10) > 0) {
    let banType = arg[1].slice(-1)
    if (!BAN_UNITS[banType]) banType = 'm'
    return {
      banTime: parseInt(arg[1], 10) * BAN_UNITS[banType],
      banUser,
      autoBan: false
    }
  }

  const replyMember = await ctx.telegram.getChatMember(
    ctx.message.chat.id,
    ctx.message.reply_to_message.from.id
  )

  if (replyMember.status === 'restricted') {
    return { banTime: -1, banUser, autoBan: false }
  }

  return {
    banTime: ctx.group.info.settings.banan.default,
    banUser,
    autoBan: true
  }
}

module.exports = async (ctx) => {
  const arg = ctx.message.text.split(/ +/)
  const chatMember = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id)
  const isAdmin = chatMember && ['creator', 'administrator'].includes(chatMember.status)

  let banTime = getRandomInt(60, 600)
  let banUser = ctx.from
  let autoBan = false

  if (isAdmin) {
    if (ctx.message.reply_to_message) {
      const parsed = await parseAdminBan(ctx, arg)
      banTime = parsed.banTime
      banUser = parsed.banUser
      autoBan = parsed.autoBan
    } else {
      // Admin without reply — show stats
      return ctx.replyWithHTML(ctx.i18n.t('banan.show', {
        name: userName(ctx.from, true)
      }))
    }
  }

  const banMember = await ensureBanMember(ctx, banUser.id)
  if (!banMember) {
    return ctx.replyWithHTML(ctx.i18n.t('banan.error'))
  }

  if (autoBan) banTime *= (banMember.banan.stack + 1)

  // Unban flow (already restricted → lift restrictions)
  if (banTime < 0) {
    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, banUser.id, {
        until_date: ctx.message.date,
        can_send_messages: true,
        can_send_other_messages: true,
        can_send_media_messages: true,
        can_add_web_page_previews: true
      })
      await ctx.replyWithHTML(ctx.i18n.t('banan.pick', {
        name: userName(banUser, true)
      }))
      banMember.banan.sum -= (
        banMember.banan.last.how - (ctx.message.date - banMember.banan.last.time)
      )
    } catch (error) {
      const errorKey = mapTelegramError(error, 'banan')
      return ctx.replyWithHTML(ctx.i18n.t(errorKey))
    }
    banMember.banan.time = Date.now()
    return banMember.save()
  }

  // Ban flow
  banTime = clampBanTime(banTime)
  const now = Math.floor(Date.now() / 1000)
  const unixBanTime = now + banTime
  const banDuration = formatDuration(banTime, ctx)
  const isSelfBan = ctx.from.id === banUser.id

  // Channel ban — separate API
  if (ctx.message.reply_to_message?.sender_chat) {
    return banSenderChat(ctx, ctx.message.reply_to_message.sender_chat, unixBanTime, banDuration, banUser)
  }

  // User ban
  try {
    await ctx.telegram.restrictChatMember(ctx.chat.id, banUser.id, {
      until_date: unixBanTime
    })
  } catch (error) {
    const errorKey = mapTelegramError(error, 'banan')
    return ctx.replyWithHTML(ctx.i18n.t(errorKey))
  }

  if (banUser.id === 686968130) {
    await ctx.replyWithDocument(
      { source: 'assets/arkasha_banan.webp' },
      { reply_to_message_id: ctx.message.message_id }
    ).catch(() => {})
  }

  const easterKey = getEasterEggKey(banTime, isSelfBan, banMember)
  const message = await ctx.replyWithHTML(ctx.i18n.t(easterKey || 'banan.suc', {
    name: userName(banUser, true),
    duration: banDuration,
    count: (banMember.banan.num || 0) + 1
  }))

  banMember.banan.num += 1
  banMember.banan.sum += banTime
  banMember.banan.last = {
    who: ctx.from.id,
    how: banTime,
    time: ctx.message.date
  }
  banMember.banan.time = Date.now()
  if (autoBan) banMember.banan.stack += 1
  await banMember.save()

  if (isSelfBan) {
    scheduleSelBanCleanup(ctx, message.message_id)
  }
}
