const Telegraf = require('telegraf')
const session = require('telegraf/session')

const bot = new Telegraf(process.env.BOT_TOKEN)
bot.use(session())
bot.on('text', (ctx) => {
  ctx.reply(`Last message: ${ctx.session.last}`)
  ctx.session.last = ctx.message.text
  console.log(ctx.session.last)
})
bot.startPolling()