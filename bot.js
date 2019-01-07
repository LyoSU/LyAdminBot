const Telegraf = require('telegraf')
const session = require('telegraf/session')

const bot = new Telegraf(process.env.BOT_TOKEN)
bot.use(session())
bot.on('text', (ctx) => {
  ctx.reply(`Last message: ${ctx.session.counter}`)
  ctx.session.counter = ctx.message.text
  console.log("test")
})
bot.startPolling()