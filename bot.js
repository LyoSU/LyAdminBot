const Telegraf = require('telegraf')
const session = require('telegraf/session')
const humanizeDuration = require('humanize-duration')

const bot = new Telegraf(process.env.BOT_TOKEN)

bot.telegram.getMe().then((botInfo) => {
  bot.options.username = botInfo.username
})

bot.use(session())

function userLogin (from, url = false) {
  var login = from.first_name
  if (from.last_name) login += ' ' + from.last_name
  if (url === true) login = `<a href="tg://user?id=${from.id}">${login}</a>`
  return login
}

function getRandomInt (min, max) {
  return Math.floor(Math.random() * (max - min)) + min
}

bot.command('help', (ctx) => {
  return ctx.replyWithHTML(`<b>${userLogin(ctx.from)}</b> пидор дня`)
})

bot.command('type', (ctx) => {
  return ctx.replyWithHTML(`<b>Chat type:</b> <pre>${ctx.chat.type}</pre>`)
})

bot.command('new_banan', (ctx) => {
  var arg = ctx.message.text.split(/ +/)
  console.log(ctx)
  bot.telegram.getChatMember(ctx.chat.id, ctx.from.id).then((getChatMember) => {
    var userStatus = getChatMember.status
    if (userStatus === 'creator' || userStatus === 'administrator') {
      if (ctx.message.reply_to_message) {
        var banTimeArr = { 'm': 60, 'h': 3600, 'd': 86400 }

        if (arg[1] === null) {

        } else {

        }

        ctx.replyWithHTML(`${userLogin(ctx.from, true)} показал(а) 🍌 ${userLogin(ctx.message.reply_to_message.from, true)}`)
      } else {
        ctx.replyWithHTML(`${userLogin(ctx.from, true)} показал(а) 🍌`)
      }
    } else {
      var banTime = getRandomInt(60, 600)
      var unixBanTime = Math.floor(new Date() / 1000) + banTime
      var banDuration = humanizeDuration(banTime * 1000, { language: 'ru' })

      bot.telegram.restrictChatMember(ctx.chat.id, ctx.from.id, { until_date: unixBanTime }).then(() => {
        ctx.replyWithHTML(`${userLogin(ctx.from, true)} получает 🍌 на <b>${banDuration}</b>`)
      })
    }
  })
})

bot.command('test', (ctx) => {
  return ctx.replyWithHTML(`name: ${userLogin(ctx.from)}`)
})

bot.on('message', (ctx) => {
  console.log(ctx.message)

  if (ctx.chat.id > 0) {
    ctx.reply(`Я работаю только в группах`)
  } else {

  }
})

bot.catch((err) => {
  console.log('Ooops', err)
})

bot.startPolling()
