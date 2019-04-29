const mongoose = require('mongoose')
const path = require('path')
const Telegraf = require('telegraf')
const rateLimit = require('telegraf-ratelimit')
const I18n = require('telegraf-i18n')
const {
  onlyAdmin,
  userUpdate,
  groupUpdate,
} = require('./middlewares')
const {
  handleMessage,
  handleHelp,
  handlePing,
  handleWelcome,
  handleBanan,
  handleKick,
  handleDelete,
  handleTop,
  handleTopBanan,
  handleMyStats,
  handleExtraList,
  handleAdminWelcome,
  handleAdminWelcomeGif,
  handleAdminWelcomeGifReset,
  handleAdminWelcomeText,
  handleAdminWelcomeTextReset,
  handleAdminExtra,
  handleSendSettingsJson,
  handleAdminJsonReset,
  handleAdminReset,
  handleExtra,
} = require('./handlers')


global.botStart = new Date()

mongoose.connect(process.env.MONGODB_URI, {
  useCreateIndex: true,
  useNewUrlParser: true,
})

const db = mongoose.connection

db.on('error', (err) => {
  console.log('error', err)
})

const limitConfig = {
  window: 1000,
  limit: 1,
}
const bananLimitConfig = {
  window: 10 * 1000,
  limit: 1,
  onLimitExceeded: (ctx) => ctx.deleteMessage(),
}

const i18n = new I18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'ru',
})

const bot = new Telegraf(process.env.BOT_TOKEN)

bot.telegram.getMe().then((botInfo) => {
  bot.options.username = botInfo.username
})

bot.use(rateLimit(limitConfig))

bot.use((ctx, next) => {
  ctx.ms = new Date()
  next()
})
bot.use(i18n.middleware())
bot.use(async (ctx, next) => {
  userUpdate(ctx)
  await groupUpdate(ctx)
  await next(ctx)
  const ms = new Date() - ctx.ms

  console.log('Response time %sms', ms)
})

bot.command('test', rateLimit(bananLimitConfig), (ctx) => ctx.reply(new Date()))

bot.command('help', handleHelp)
bot.command('ping', handlePing)
bot.command('banan', rateLimit(bananLimitConfig), handleBanan)
bot.command('kick', handleKick)
bot.command('del', handleDelete)
bot.command('top', handleTop)
bot.command('top_banan', handleTopBanan)
bot.command('mystats', handleMyStats)
bot.command('extras', handleExtraList)
bot.hashtag(() => true, rateLimit({ window: 3 * 1000, limit: 1 }), handleExtra)
bot.hears(/^!extra($|\s.*)/, onlyAdmin, handleAdminExtra)
bot.hears('!welcome', onlyAdmin, handleAdminWelcome)
bot.hears('!gif', onlyAdmin, handleAdminWelcomeGif)
bot.hears('!gif-reset', onlyAdmin, handleAdminWelcomeGifReset)
bot.hears('!text', onlyAdmin, handleAdminWelcomeText)
bot.hears('!text-reset', onlyAdmin, handleAdminWelcomeTextReset)
bot.hears('!reset', onlyAdmin, handleAdminReset)
bot.hears('!json', onlyAdmin, handleSendSettingsJson)
bot.on('document', onlyAdmin, handleAdminJsonReset)
bot.on('new_chat_members', handleWelcome)
bot.on('message', handleMessage)

bot.catch((error) => {
  console.log('Ooops', error)
})

bot.launch()
