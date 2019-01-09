const Telegraf = require('telegraf')
const path = require('path')
const I18n = require('telegraf-i18n')

const session = require('telegraf/session')
const humanizeDuration = require('humanize-duration')

const i18n = new I18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'en',
  sessionName: 'session',
  useSession: true
})

const bot = new Telegraf(process.env.BOT_TOKEN)

bot.telegram.getMe().then((botInfo) => {
  bot.options.username = botInfo.username
})

bot.use(session())
bot.use(i18n.middleware())

function userLogin (user, url = false) {
  var login = user.first_name
  if (user.last_name) login += ' ' + user.last_name
  if (url === true) login = `<a href="tg://user?id=${user.id}">${login}</a>`
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
  const arg = ctx.message.text.split(/ +/)
  console.log(ctx)
  bot.telegram.getChatMember(ctx.chat.id, ctx.from.id).then((getChatMember) => {
    var userStatus = getChatMember.status
    if (userStatus === 'creator' || userStatus === 'administrator') {
      if (ctx.message.reply_to_message) {
        if (arg[1] === null) {
          var banUser = ctx.from
        } else {
          var banTimeArr = { 'm': 60, 'h': 3600, 'd': 86400 }
          var banType = banTimeArr[arg[1].slice(-1)]
          if (banType === undefined) var banType = 60
          var banTime = parseInt(arg[1]) * banType
          var banUser = ctx.message.reply_to_message.from
        }
      } else {
        var banUser = ctx.from
      }
    } else {
      var banTime = getRandomInt(60, 600)
      var banUser = ctx.from
    }

    if (banTime) {
      var unixBanTime = Math.floor(new Date() / 1000) + banTime
      var banDuration = humanizeDuration(banTime * 1000, { language: 'ru' })
      
      bot.telegram.restrictChatMember(ctx.chat.id, banUser.id, { until_date: unixBanTime }).then(() => {
        ctx.replyWithHTML(`${userLogin(banUser, true)} получает 🍌\n<b>Срок:</b> ${banDuration}`)
      }).catch((err) => {
        ctx.replyWithHTML(`<b>У меня не получилось выдать 🍌</b>\n<pre>${err}</pre>`)
      })
    }else{
      ctx.replyWithHTML(`${userLogin(banUser, true)} показал(а) 🍌`)
    }
  })
})

bot.command('test', (ctx) => {
  return ctx.replyWithHTML(ctx.i18n.t('cmd.test', {userLogin: ctx.from.username}))
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
