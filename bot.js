const path = require('path')
const Telegraf = require('telegraf')
const session = require('telegraf/session')
const rateLimit = require('telegraf-ratelimit')
const I18n = require('telegraf-i18n')
const {
  db
} = require('./database')
const {
  stats,
  onlyGroup,
  onlyAdmin,
  casBan,
  openaiSpamCheck
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
  handleSendMembers,
  handleSaveSticker,
  handleSendSettingsJson,
  handleAdminJsonReset,
  handleAdminReset,
  handleExtra,
  handleBanAllChannel
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
  if (ctx.update.my_chat_member) console.log(ctx.update)
  else return next()
})

bot.use((ctx, next) => {
  next().catch((error) => {
    console.log('Oops', error)
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
  limit: 1
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
  // if (!ctx.session) console.error(ctx)
  ctx.session.userInfo = await updateUser(ctx)
  if (ctx.session.userInfo.locale) ctx.i18n.locale(ctx.session.userInfo.locale)

  if (ctx.group) {
    ctx.group.info = await updateGroup(ctx)
    if (!ctx.group.members) ctx.group.members = []
    ctx.group.members[ctx.from.id] = await updateGroupMember(ctx)
    if (ctx.group.info.settings.locale) ctx.i18n.locale(ctx.group.info.settings.locale)
  }

  if (ctx.message) {
    let isSpam = false

    // Check for OpenAI global ban first
    if (ctx.session.userInfo && ctx.session.userInfo.isGlobalBanned) {
      console.log(`[GLOBAL BAN] User ${ctx.from.first_name} (ID: ${ctx.from.id}) is globally banned by AI. Reason: ${ctx.session.userInfo.globalBanReason}. Banning in current group.`)
      try {
        await ctx.telegram.kickChatMember(ctx.chat.id, ctx.from.id)
        await ctx.replyWithHTML(ctx.i18n.t('global_ban.kicked', {
          name: ctx.from.first_name,
          reason: ctx.session.userInfo.globalBanReason
        }))
      } catch (error) {
        console.error(`[GLOBAL BAN ERROR] Failed to kick globally banned user: ${error.message}`)
      }
      isSpam = true // Prevents further processing
    }

    if (!isSpam) {
      isSpam = await casBan(ctx)
    }

    if (!isSpam) { // Only run OpenAI check if not banned by CAS or globally
      isSpam = await openaiSpamCheck(ctx)
    }

    if (isSpam) {
      return next(ctx)
    }
  }

  await next(ctx)

  // Save user info after all checks, including potential global ban update by openaiSpamCheck
  if (ctx.session.userInfo) {
    await ctx.session.userInfo.save().catch((err) => { console.error('[USER SAVE ERROR]', err) })
  }
  if (ctx.group && ctx.group.info) {
    await ctx.group.info.save().catch(() => {})
    await ctx.group.members[ctx.from.id].save().catch(() => {})
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
bot.on('message', handleMessage)

db.connection.once('open', async () => {
  console.log('Connected to MongoDB')

  if (process.env.BOT_DOMAIN) {
    bot.launch({
      webhook: {
        domain: process.env.BOT_DOMAIN,
        hookPath: `/LyAdminBot:${process.env.BOT_TOKEN}`,
        port: process.env.WEBHOOK_PORT || 2200
      }
    }).then(() => {
      console.log('bot start webhook')
    })
  } else {
    bot.launch().then(() => {
      console.log('bot start polling')
    })
  }
})
