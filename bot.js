const path = require('path')
const Telegraf = require('telegraf')
const session = require('telegraf/session')
const rateLimit = require('telegraf-ratelimit')
const I18n = require('telegraf-i18n')
const { bot: botLog, globalBan, db: dbLog } = require('./helpers/logger')
const {
  db
} = require('./database')
const {
  stats,
  onlyGroup,
  onlyAdmin,
  casBan,
  spamCheck
} = require('./middlewares')
const {
  handleMessage,
  handleHelp,
  handlePing,
  handleSetLanguage,
  handleWelcome,
  handleBanan,
  handleQuote,
  handleKick,
  handleDelete,
  handleTop,
  handleTopBanan,
  handleMyStats,
  handleExtraList,
  handleWebAuth,
  handleAdminWelcome,
  handleAdminWelcomeGif,
  handleAdminWelcomeGifReset,
  handleAdminWelcomeText,
  handleAdminWelcomeTextReset,
  handleAdminExtra,
  handleAdminMaxExtra,
  handleAdminCas,
  handleAdminSpamSettings,
  handleSendMembers,
  handleSaveSticker,
  handleSendSettingsJson,
  handleAdminJsonReset,
  handleAdminReset,
  handleExtra,
  handleBanAllChannel,
  handleReport,
  isBotMentionReport,
  handleTrust,
  handleUntrust
} = require('./handlers')
const {
  updateUser,
  updateGroup,
  updateGroupMember
} = require('./helpers')

global.startDate = new Date()

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: {
    webhookReply: false
  }
})

bot.on(['channel_post', 'edited_channel_post'], () => {})

bot.use((ctx, next) => {
  if (ctx.update.my_chat_member) botLog.debug({ update: ctx.update }, 'my_chat_member update')
  else return next()
})

bot.use((ctx, next) => {
  next().catch(async (error) => {
    const errorMsg = error.message || error.description || ''

    // Self-kick if bot can't write to group
    if (
      errorMsg.includes('CHAT_WRITE_FORBIDDEN') ||
      errorMsg.includes('bot was kicked') ||
      errorMsg.includes('bot is not a member') ||
      errorMsg.includes('have no rights to send a message') ||
      errorMsg.includes('need administrator rights')
    ) {
      const chatId = ctx.chat && ctx.chat.id
      const chatTitle = ctx.chat && ctx.chat.title
      botLog.warn({ chatId }, 'Cannot write to chat, leaving...')
      try {
        if (chatId) {
          await ctx.telegram.leaveChat(chatId)
          botLog.info({ chatId, chatTitle: chatTitle || 'unknown' }, 'Left chat')
        }
      } catch (leaveError) {
        botLog.error({ chatId, err: leaveError.message }, 'Failed to leave chat')
      }
      return
    }

    botLog.error({ err: error }, 'Unhandled error')
  })
  return true
})

bot.use(stats)

bot.context.db = db

const i18n = new I18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

bot.use(rateLimit({
  window: 1000,
  limit: 5
}))

bot.use(session({ ttl: 60 * 5 }))
bot.use(session({
  property: 'group',
  getSessionKey: (ctx) => {
    if (ctx.from && ctx.chat && ['supergroup', 'group'].includes(ctx.chat.type)) {
      return `${ctx.chat.id}`
    }
    return null
  },
  ttl: 60 * 5
}))

bot.use(i18n.middleware())

bot.use(async (ctx, next) => {
  // Skip if no session or no user (e.g., channel posts, service messages)
  if (!ctx.session || !ctx.from) {
    return next(ctx)
  }

  ctx.session.userInfo = await updateUser(ctx)
  if (ctx.session.userInfo.locale) ctx.i18n.locale(ctx.session.userInfo.locale)

  if (ctx.group && ctx.from) {
    ctx.group.info = await updateGroup(ctx)
    if (!ctx.group.members) ctx.group.members = []
    ctx.group.members[ctx.from.id] = await updateGroupMember(ctx)
    if (ctx.group.info.settings.locale) ctx.i18n.locale(ctx.group.info.settings.locale)
  }

  if (ctx.message && ctx.from) {
    let isSpam = false

    // Function to check if global ban has expired (24 hours)
    const isGlobalBanExpired = (globalBanDate) => {
      if (!globalBanDate) return true
      const now = new Date()
      const banTime = new Date(globalBanDate)
      const hoursDiff = (now - banTime) / (1000 * 60 * 60)
      return hoursDiff >= 24
    }

    // Check for OpenAI global ban first
    if (ctx.session.userInfo && ctx.session.userInfo.isGlobalBanned) {
      // Check if global ban has expired
      if (isGlobalBanExpired(ctx.session.userInfo.globalBanDate)) {
        // Clear expired global ban
        ctx.session.userInfo.isGlobalBanned = false
        ctx.session.userInfo.globalBanReason = undefined
        ctx.session.userInfo.globalBanDate = undefined
        await ctx.session.userInfo.save().catch(err => globalBan.error({ err }, 'Failed to clear expired ban'))
        globalBan.info({ userId: ctx.from.id, firstName: ctx.from.first_name }, 'Cleared expired global ban')
      } else {
        // Check if this group participates in global bans
        const globalBanEnabled = ctx.group &&
                               ctx.group.info &&
                               ctx.group.info.settings &&
                               ctx.group.info.settings.openaiSpamCheck &&
                               ctx.group.info.settings.openaiSpamCheck.globalBan !== false

        if (globalBanEnabled) {
          const banDate = new Date(ctx.session.userInfo.globalBanDate)
          const timeLeft = 24 - ((new Date() - banDate) / (1000 * 60 * 60))
          globalBan.warn({
            userId: ctx.from.id,
            firstName: ctx.from.first_name,
            reason: ctx.session.userInfo.globalBanReason,
            timeLeftHours: timeLeft.toFixed(1)
          }, 'User globally banned by AI, banning in current group')
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id)
            await ctx.telegram.kickChatMember(ctx.chat.id, ctx.from.id)
            await ctx.replyWithHTML(ctx.i18n.t('global_ban.kicked', {
              name: ctx.from.first_name,
              reason: ctx.session.userInfo.globalBanReason
            }))
          } catch (error) {
            globalBan.error({ err: error.message, userId: ctx.from.id }, 'Failed to kick globally banned user')
          }
          isSpam = true // Prevents further processing
        } else {
          globalBan.debug({
            userId: ctx.from.id,
            firstName: ctx.from.first_name,
            groupTitle: ctx.chat.title
          }, 'User globally banned but group has global ban disabled')
        }
      }
    }

    if (!isSpam) {
      isSpam = await casBan(ctx)
    }

    if (!isSpam) { // Only run OpenAI check if not banned by CAS or globally
      isSpam = await spamCheck(ctx)
    }

    if (isSpam) {
      return next(ctx)
    }
  }

  await next(ctx)

  // Save user info after all checks, including potential global ban update by openaiSpamCheck
  // Use Promise.allSettled to avoid parallel save conflicts
  const savePromises = []

  if (ctx.session.userInfo && !ctx.session.userInfo.isSaving) {
    ctx.session.userInfo.isSaving = true
    savePromises.push(
      ctx.session.userInfo.save()
        .then(() => { ctx.session.userInfo.isSaving = false })
        .catch((err) => {
          ctx.session.userInfo.isSaving = false
          dbLog.error({ err }, 'User save error')
        })
    )
  }

  if (ctx.group && ctx.group.info && !ctx.group.info.isSaving) {
    ctx.group.info.isSaving = true
    savePromises.push(
      ctx.group.info.save()
        .then(() => { ctx.group.info.isSaving = false })
        .catch(() => { ctx.group.info.isSaving = false })
    )
  }

  if (ctx.group && ctx.group.members && ctx.from && ctx.group.members[ctx.from.id] && !ctx.group.members[ctx.from.id].isSaving) {
    ctx.group.members[ctx.from.id].isSaving = true
    savePromises.push(
      ctx.group.members[ctx.from.id].save()
        .then(() => { ctx.group.members[ctx.from.id].isSaving = false })
        .catch(() => { ctx.group.members[ctx.from.id].isSaving = false })
    )
  }

  if (savePromises.length > 0) {
    await Promise.allSettled(savePromises)
  }
})

bot.command('help', handleHelp)
bot.command('ping', handlePing)
bot.command('lang', handleSetLanguage)
bot.command('web', handleWebAuth)
bot.command('q', handleQuote)
bot.command('kick', onlyGroup, handleKick)
bot.command('del', handleDelete)
bot.command('top', onlyGroup, handleTop)
bot.command('top_banan', onlyGroup, handleTopBanan)
bot.command('mystats', onlyGroup, handleMyStats)
bot.command('extras', onlyGroup, handleExtraList)
bot.command('report', onlyGroup, handleReport)

bot.command('banan', onlyGroup, rateLimit({
  window: 3 * 1000,
  limit: 1,
  keyGenerator: (ctx) => ctx.chat.id,
  onLimitExceeded: (ctx) => ctx.deleteMessage()
}), handleBanan)

bot.use(handleBanAllChannel)

bot.hears(/^!extra\s(?:(#?))([^\s]+)/, onlyAdmin, handleAdminExtra)
bot.hears(/^!extra-max (\d*)/, onlyAdmin, handleAdminMaxExtra)
bot.hears('!welcome', onlyAdmin, handleAdminWelcome)
bot.hears('!cas', onlyAdmin, handleAdminCas)
bot.hears(/^!spam(?:\s(.*))?/, onlyAdmin, handleAdminSpamSettings)
bot.hears(/^!trust(?:\s(.*))?/, onlyAdmin, handleTrust)
bot.hears(/^!untrust(?:\s(.*))?/, onlyAdmin, handleUntrust)
bot.hears('!gif', onlyAdmin, handleAdminWelcomeGif)
bot.hears('!gif-reset', onlyAdmin, handleAdminWelcomeGifReset)
bot.hears('!text', onlyAdmin, handleAdminWelcomeText)
bot.hears('!text-reset', onlyAdmin, handleAdminWelcomeTextReset)
bot.hears('!reset', onlyAdmin, handleAdminReset)
bot.hears('!users', onlyAdmin, handleSendMembers)
bot.hears(/^!s(?:\s([^\s]+)|)/, onlyAdmin, handleSaveSticker)
bot.hears('!json', onlyAdmin, handleSendSettingsJson)

bot.action(/set_language:(.*)/, handleSetLanguage)
bot.hashtag(() => true, rateLimit({ window: 3 * 1000, limit: 1 }), handleExtra)

bot.on('document', handleAdminJsonReset)
bot.on('new_chat_members', handleWelcome)

// Handle @botusername mentions as report (in reply to a message)
bot.on('text', (ctx, next) => {
  if (isBotMentionReport(ctx)) {
    return handleReport(ctx)
  }
  return next()
})

bot.on('message', handleMessage)

db.connection.once('open', async () => {
  dbLog.info('Connected to MongoDB')

  if (process.env.BOT_DOMAIN) {
    bot.launch({
      webhook: {
        domain: process.env.BOT_DOMAIN,
        hookPath: `/LyAdminBot:${process.env.BOT_TOKEN}`,
        port: process.env.WEBHOOK_PORT || 2200
      }
    }).then(() => {
      botLog.info({ mode: 'webhook', port: process.env.WEBHOOK_PORT || 2200 }, 'Bot started')
    })
  } else {
    bot.launch().then(() => {
      botLog.info({ mode: 'polling' }, 'Bot started')
    })
  }
})
