const Telegraf = require('telegraf')
const path = require('path')
const I18n = require('telegraf-i18n')

const session = require('telegraf/session')
const humanizeDuration = require('humanize-duration')

const i18n = new I18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'ru',
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

bot.command('nbanan', async (ctx) => {
  var arg = ctx.message.text.split(/ +/)
  await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id).then((result) => {
    chatStatus = result.status
  })

  if (chatStatus === 'creator' || chatStatus === 'administrator') {
    if (ctx.message.reply_to_message) {
      await bot.telegram.getChatMember(ctx.chat.id, ctx.message.reply_to_message.from.id).then((result) => {
        replyStatus = result.status
      })

      if (replyStatus === 'restricted') {
        var banUser = ctx.message.reply_to_message.from
        var banTime = -1
      } else {
        if (arg[1] === null) {
          var banUser = ctx.from
          var banTime = 300
        } else {
          var banUser = ctx.message.reply_to_message.from
          if (arg[1]) {
            var banTimeArr = { 'm': 60, 'h': 3600, 'd': 86400 }
            var banType = banTimeArr[arg[1].slice(-1)]
            var banTime = parseInt(arg[1]) * banType
          } else {
            var banTime = 300
          }
        }
      }
    } else {
      var banUser = ctx.from
    }
  } else {
    var banUser = ctx.from
    var banTime = getRandomInt(60, 600)
  }

  if (banTime) {
    if (banTime > 0) {
      var unixBanTime = Math.floor(new Date() / 1000) + banTime
      var banDuration = humanizeDuration(banTime * 1000, { language: ctx.i18n.locale() })
      
      bot.telegram.restrictChatMember(ctx.chat.id, banUser.id, { until_date: unixBanTime }).then(() => {
        ctx.replyWithHTML(
          ctx.i18n.t('banan.suc', {
            login: userLogin(banUser, true),
            duration: banDuration,
          })
        )
      }).catch((err) => {
        ctx.replyWithHTML(
          ctx.i18n.t('banan.error', {
            err: err
          })
        )
      })
    } else {
      bot.telegram.unbanChatMember(ctx.chat.id, banUser.id).then(() => {
        ctx.replyWithHTML(
          ctx.i18n.t('banan.pick', {
            login: userLogin(banUser, true)
          })
        )
      })
    }
  }else{
    ctx.replyWithHTML(
      ctx.i18n.t('banan.show', {
        login: userLogin(banUser, true)
      })
    )
  }
})

bot.command('kick', async (ctx) => {
  await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id).then((result) => {
    chatStatus = result.status
  })

  if (chatStatus === 'creator' || chatStatus === 'administrator') {
    if (ctx.message.reply_to_message) {
      var kickUser = ctx.message.reply_to_message.from
    } else {
      ctx.replyWithHTML(
        ctx.i18n.t('kick.who')
      )
    }
  } else {
    var kickUser = ctx.from
  }

  if (kickUser) {
    bot.telegram.kickChatMember(ctx.chat.id, kickUser.id).then(() => {
      ctx.replyWithHTML(
        ctx.i18n.t('kick.suc', {
          login: userLogin(kickUser, true)
        })
      )
      bot.telegram.unbanChatMember(ctx.chat.id, kickUser.id)
    })
  }
})

bot.command('test', (ctx) => {
  return ctx.replyWithHTML(ctx.i18n.t('cmd.test', {userLogin: userLogin(ctx.from, true)}))
})

bot.on('new_chat_members', (ctx) => {
  ctx.replyWithHTML(
    "Привет пидарас"
  )
})

bot.on('message', (ctx) => {
  console.log(ctx.message)

  if (ctx.chat.id > 0) {
    ctx.replyWithHTML(
      ctx.i18n.t('private.start', {
        login: userLogin(ctx.from)
      })
    )
  } else {

  }
})

bot.catch((err) => {
  console.log('Ooops', err)
})

bot.startPolling()
