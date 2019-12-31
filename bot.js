const path = require('path')
const Telegraf = require('telegraf')
const session = require('telegraf/session')
const rateLimit = require('telegraf-ratelimit')
const I18n = require('telegraf-i18n')
const {
  db
} = require('./database')
const {
  onlyGroup,
  onlyAdmin,
  casBan
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
  handleExtra
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

bot.context.db = db

const limitConfig = {
  window: 1000,
  limit: 1
}

const bananLimitConfig = {
  window: 3 * 1000,
  limit: 1,
  keyGenerator: (ctx) => ctx.chat.id,
  onLimitExceeded: (ctx) => ctx.deleteMessage()
}

const i18n = new I18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'ru',
  defaultLanguageOnMissing: true
})

bot.use(rateLimit(limitConfig))

bot.use(async (ctx, next) => {
  ctx.ms = new Date()
  next()
})

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
  ctx.session.userInfo = await updateUser(ctx)
  if (ctx.session.userInfo.locale) ctx.i18n.locale(ctx.session.userInfo.locale)

  if (ctx.group) {
    ctx.group.info = await updateGroup(ctx)
    if (!ctx.group.members) ctx.group.members = []
    ctx.group.members[ctx.from.id] = await updateGroupMember(ctx)
    if (ctx.group.info.settings.locale) ctx.i18n.locale(ctx.group.info.settings.locale)
  }
  await casBan(ctx)

  await next(ctx)

  await ctx.session.userInfo.save()
  if (ctx.group && ctx.group.info) {
    await ctx.group.info.save()
    await ctx.group.members[ctx.from.id].save()
  }

  const ms = new Date() - ctx.ms

  console.log('Response time %sms', ms)
})

bot.command('help', handleHelp)
bot.command('ping', handlePing)
bot.command('lang', handleSetLanguage)
bot.command('web', handleWebAuth)
bot.command('q', handleQuote)
bot.command('banan', onlyGroup, rateLimit(bananLimitConfig), handleBanan)
bot.command('kick', onlyGroup, handleKick)
bot.command('del', handleDelete)
bot.command('top', onlyGroup, handleTop)
bot.command('top_banan', onlyGroup, handleTopBanan)
bot.command('mystats', onlyGroup, handleMyStats)
bot.command('extras', onlyGroup, handleExtraList)

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

bot.on('document', onlyAdmin, handleAdminJsonReset)
bot.on('new_chat_members', handleWelcome)
bot.on('message', handleMessage)

bot.catch((error) => {
  console.log('Oops', error)
})

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
