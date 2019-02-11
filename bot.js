const mongoose = require('mongoose')
const path = require('path')
const Telegraf = require('telegraf')
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
  handleMyStats,
  handleAdminWelcome,
  handleAdminWelcomeGif,
  handleAdminWelcomeText,
  handleAdminExtra,
  handleReset,
  handleSendSettingsJson,
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

const i18n = new I18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'ru',
})

const bot = new Telegraf(process.env.BOT_TOKEN)

bot.telegram.getMe().then((botInfo) => {
  bot.options.username = botInfo.username
})

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

bot.command('help', handleHelp)
bot.command('ping', handlePing)
bot.command('banan', handleBanan)
bot.command('kick', handleKick)
bot.command('del', handleDelete)
bot.command('mystats', handleMyStats)
bot.hears('!welcome', onlyAdmin, handleAdminWelcome)
bot.hears('!gif', onlyAdmin, handleAdminWelcomeGif)
bot.hears('!text', onlyAdmin, handleAdminWelcomeText)
bot.hears(/^!extra($|\s.*)/, onlyAdmin, handleAdminExtra)
bot.hears('!reset', onlyAdmin, handleReset)
bot.hears('!json', onlyAdmin, handleSendSettingsJson)
bot.hears(/^#/, handleExtra)
bot.on('new_chat_members', handleWelcome)
bot.on('message', handleMessage)

bot.catch((error) => {
  console.log('Ooops', error)
})

bot.launch()
