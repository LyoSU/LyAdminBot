const Telegraf = require('telegraf')
const session = require('telegraf/session')

const bot = new Telegraf(process.env.BOT_TOKEN)

bot.telegram.getMe().then((botInfo) => {
  bot.options.username = botInfo.username
})

bot.use(session())

bot.command('type', (ctx) =>{
  console.log(ctx.message)
  return ctx.reply(`Type: ${ctx.chat.type}`)
})

bot.command('test', (ctx) =>{
  return ctx.reply(`name: ${ctx.from.first_name}`)
})

bot.on('message', (ctx) => {
  console.log(ctx.message)

  if( ctx.chat.id > 0 ){
    ctx.reply(`Я работаю только в группах`)
  }else{

  }
})

bot.startPolling()