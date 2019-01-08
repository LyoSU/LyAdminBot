const Telegraf = require('telegraf')
const session = require('telegraf/session')

const bot = new Telegraf(process.env.BOT_TOKEN)

bot.telegram.getMe().then((botInfo) => {
  bot.options.username = botInfo.username
})

bot.use(session())

function userLogin(from){
  login = from.first_name
  if(from.last_name) login += ' ' + from.last_name
  return login
}

bot.command('help', (ctx) => {
  return ctx.replyWithHTML(`<b>${userLogin(ctx.from)}</b> пидор дня`)
})

bot.command('type', (ctx) => {
  return ctx.replyWithHTML(`<b>Chat type:</b> <pre>${ctx.chat.type}</pre>`)
})

bot.command('banan', (ctx) => {
  bot.telegram.getChatMember(ctx.chat.id, ctx.from.id).then((getChatMember) => {
    console.log(getChatMember.status)
    if(getChatMember.status == ('creator' || 'administrator')) {
      return ctx.replyWithHTML('ты не пидор')
    }else{
      return ctx.replyWithHTML('ты пидор')
    }
  })
})

bot.command('test', (ctx) => {
  return ctx.replyWithHTML(`name: ${userLogin(ctx.from)}`)
})

bot.on('message', (ctx) => {
  console.log(ctx.message)

  if( ctx.chat.id > 0 ) {
    ctx.reply(`Я работаю только в группах`)
  } else {

  }
})

bot.catch((err) => {
  console.log('Ooops', err)
})

bot.startPolling()