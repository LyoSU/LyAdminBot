const mongoose = require('mongoose')
const path = require('path')
const Telegraf = require('telegraf')
const TelegrafMixpanel = require('telegraf-mixpanel')
const I18n = require('telegraf-i18n')
const session = require('telegraf/session')
const {
  onlyAdmin,
  userUpdate,
  groupUpdate
} = require('./middlewares')
const {
  handleMessage,
  handleHelp,
  handleWelcome,
  handleBanan,
  handleKick,
  handleDelete,
  handleAddWelcomeGif,
  handleAddWelcomeText,
  handleReset
} = require('./handlers')

mongoose.connect('mongodb://localhost:27017/LyAdminBot', {
  useCreateIndex: true,
  useNewUrlParser: true
})

const db = mongoose.connection
db.on('error', err => {
  console.log('error', err)
})

const i18n = new I18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'ru',
  sessionName: 'session',
  useSession: true
})

const bot = new Telegraf(process.env.BOT_TOKEN)
const mixpanel = new TelegrafMixpanel(process.env.MIXPANEL_TOKEN)

bot.telegram.getMe().then((botInfo) => {
  bot.options.username = botInfo.username
})

bot.use(mixpanel.middleware())
bot.use(session())
bot.use(i18n.middleware())
bot.use(async (ctx, next) => {
  const start = new Date()
  await userUpdate(ctx)
  await groupUpdate(ctx)
  await next(ctx)
  const ms = new Date() - start
  console.log('Response time %sms', ms)
})

bot.command('help', handleHelp)
bot.command('banan', handleBanan)
bot.command('kick', handleKick)
bot.command('del', handleDelete)
bot.hears('!gif', onlyAdmin, handleAddWelcomeGif)
bot.hears('!text', onlyAdmin, handleAddWelcomeText)
bot.hears('!reset', onlyAdmin, handleReset)
bot.on('new_chat_members', handleWelcome)
bot.on('message', handleMessage)

bot.catch((err) => {
  console.log('Ooops', err)
})

bot.launch()
