const mongoose = require('mongoose')
const path = require('path')
const Telegraf = require('telegraf')
const TelegrafMixpanel = require('telegraf-mixpanel')
const I18n = require('telegraf-i18n')
const session = require('telegraf/session')
const humanizeDuration = require('humanize-duration')
const User = require('./models/user')
const Group = require('./models/group')

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

bot.use( async (ctx, next) => {
  const start = new Date()
  User.findOneAndUpdate({
    telegram_id: ctx.from.id
  }, {
    first_name: ctx.from.first_name,
    last_name: ctx.from.last_name,
    username: ctx.from.username,
    last_act: ctx.message.date
  }, { new: true, upsert: true }, function (err, doc) {
    if (err) return console.log(err)
  })
  ctx.mixpanel.people.set()
  ctx.mixpanel.people.setOnce({
    $created: new Date().toISOString()
  })

  if (ctx.chat.id > 0) {

  } else {
    await Group.findOneAndUpdate({
      group_id: ctx.chat.id
    }, {
      title: ctx.chat.title
    }, { new: true, upsert: true }, function (err, doc) {
      if (err) return console.log(err)
      ctx.groupInfo = doc
    })
  }
  await next(ctx)
  const ms = new Date() - start
  console.log('Response time %sms', ms)
})

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
  ctx.mixpanel.track('banan')
  var arg = ctx.message.text.split(/ +/)
  await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id).then((result) => chatStatus = result.status)

  if (chatStatus === 'creator' || chatStatus === 'administrator') {
    if (ctx.message.reply_to_message) {
      await bot.telegram.getChatMember(ctx.chat.id, ctx.message.reply_to_message.from.id).then((result) => replyStatus = result.status)

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
      var unixBanTime = ctx.message.date + banTime
      var banDuration = humanizeDuration(banTime * 1000, { language: ctx.i18n.locale() })

      bot.telegram.restrictChatMember(ctx.chat.id, banUser.id, { until_date: unixBanTime }).then(() => {
        ctx.replyWithHTML(
          ctx.i18n.t('banan.suc', {
            login: userLogin(banUser, true),
            duration: banDuration
          })
        )
      }).catch((error) => {
        ctx.replyWithHTML(
          ctx.i18n.t('banan.error', {
            error: error
          })
        )
      })
    } else {
      bot.telegram.restrictChatMember(ctx.chat.id, banUser.id, {
        'until_date': ctx.message.date,
        'can_send_messages': true,
        'can_send_other_messages': true,
        'can_send_media_messages': true,
        'can_add_web_page_previews': true
      }).then(() => {
        ctx.replyWithHTML(
          ctx.i18n.t('banan.pick', {
            login: userLogin(banUser, true)
          })
        )
      })
    }
  } else {
    ctx.replyWithHTML(
      ctx.i18n.t('banan.show', {
        login: userLogin(banUser, true)
      })
    )
  }
})

bot.command('nkick', async (ctx) => {
  ctx.mixpanel.track('kick')
  await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id).then((result) => chatStatus = result.status)

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
    bot.telegram.unbanChatMember(ctx.chat.id, kickUser.id).then(() => {
      ctx.replyWithHTML(
        ctx.i18n.t('kick.suc', {
          login: userLogin(kickUser, true)
        })
      )
    })
  }
})

bot.command('del', async (ctx) => {
  ctx.mixpanel.track('del')
  await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id).then((result) => chatStatus = result.status)

  if (chatStatus === 'creator' || chatStatus === 'administrator') {
    bot.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id)
    if (ctx.message.reply_to_message.message_id) bot.telegram.deleteMessage(ctx.chat.id, ctx.message.reply_to_message.message_id)
  } else {
    bot.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id)
  }
})

bot.command('gif', async (ctx) => {
  await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id).then((result) => chatStatus = result.status)

  if (chatStatus === 'creator' || chatStatus === 'administrator') {
    if (ctx.message.reply_to_message.animation) {
      var gifId = ctx.message.reply_to_message.animation.file_id

      Group.findOne({
        'group_id': ctx.chat.id,
        'settings.gifs': { $in: [gifId] }
      }, function(err, doc){
          if(doc){
            Group.update(
              { group_id: ctx.chat.id }, 
              { $pull: { 'settings.gifs': gifId } }, (err, doc) => {
                if(err) return console.log(err)
                ctx.replyWithHTML(
                  ctx.i18n.t('welcome.gif.pull')
                )
              }
            )
          }else{
            Group.update(
              { group_id: ctx.chat.id }, 
              { $push: { 'settings.gifs': gifId } }, (err, doc) => {
                if(err) return console.log(err)
                ctx.replyWithHTML(
                  ctx.i18n.t('welcome.gif.push')
                )
              }
            )
          }
      })
    }
  }
})

bot.command('welcome_reset', (ctx) => {
  gifs = ["CgADAgADqAEAAmJG2Uglzd9EwW55bwI","CgADBAADyx4AAhQYZAetvXlEFn5cswI","CgADBAAD2p8AAnsaZAcJm0k7V_kXNAI","CgADAgADNQADS_BhSDpVCwqAH-ApAg","CgADAgADHwEAAvB2IUlCVQ-SgmWrHgI","CgADAgADowADW7g4StIu7SVZ0yipAg","CgADBAAD6XQAAhIZZAeTavEu0igaiAI","CgADAgADvQAD4AUwSQS5MUl_EGsyAg","CgADAgAD4AEAAlvyUgd71fE8N2Hk_QI","CgADBAADqaEAAlcZZAfGeJGIyZqlewI","CgADBAAD5IkBAAEVGGQH0W-_EJ5srcIC","CgADAgADLAADqsgYSR_BdlF8KTJMAg","CgADBAADa6AAAtIcZActYXkQawyAOgI","CgADBAADHdcAAswdZAcu3MWguaCW-AI","CgADBAADpRYAAswdZAcpeGLhy5LTGQI","CgADBAADxhoAAsUaZAfJ7wp8FdS2xQI","CgADAgAD7gEAAkil-UjXyAw0cwaZWgI","CgADBAADAgEAAh-cYVNbj7BOYD9JtgI"]

  captions = [
    'Hi, %login%',
    'Привіт, %login%✌️ Ми чекали лише тебе😘',
    'О, %login%. Ты где пропадал? Тебя только ждали.',
    '%login%, добро пожаловать в нашу компанию 🤜🏻🤛🏿',
    '%login%, приветствуем в нашем царстве👑',
    'Добрий день, %login%, не журися, козаче, тепер ти з нами😱',
    '%login%, яке щастя, що ти тепер з нами!',
    'Hisashiburi desu, %login% ✌',
    'Yahhoo %login% 🙋🏻',
    '%login%, устраивайся поудобнее😉',
    'Вы посмотрите😲 Это же %login%!',
    '%login%, ну и что ты тут забыл?😒',
    '%login%, за вход передаем!',
    'Кто разрешил сюда зайти %login% ?🤔',
    '%login% няша😘',
    'Поприветствуйте %login% 🙋🏼‍♂️',
    '%login%, а кто это такой к нам пришел? 😲',
    '%login%, мяу😽',
    '👏🏻 AYAYA %login% 😝',
  ]

  Group.update(
    { group_id: ctx.chat.id }, 
    { 'settings.gifs': gifs, 'settings.captions': captions }, (err, doc) => {
      if(err) return console.log(err)
      ctx.replyWithHTML(
        ctx.i18n.t('welcome.reset')
      )
    }
  )
})

bot.command('test', (ctx) => {
  return ctx.replyWithHTML(ctx.i18n.t('cmd.test', { userLogin: userLogin(ctx.from, true) }))
})

bot.on('new_chat_members', async (ctx) => {
  ctx.mixpanel.track('new member')
  var gifs = ctx.groupInfo.settings.gifs
  var randomGif = gifs[Math.floor(Math.random()*gifs.length)]
  var captions = ctx.groupInfo.settings.captions
  var randomCaption = captions[Math.floor(Math.random()*captions.length)]
  const message = await ctx.replyWithDocument(
    randomGif,
    {'caption': randomCaption.replace('%login%', userLogin(ctx.from))}
  )
  setTimeout(() => {
    ctx.deleteMessage(message.message_id)
  }, 5000)
})

bot.on('message', (ctx) => {
  if (ctx.chat.id > 0) {
    ctx.replyWithHTML(
      ctx.i18n.t('private.start', {
        login: userLogin(ctx.from)
      })
    )
    ctx.mixpanel.track('private message')
  } else {
    ctx.mixpanel.track('group message', { group: ctx.chat.id })
  }
})

bot.catch((err) => {
  console.log('Ooops', err)
})

bot.startPolling()
