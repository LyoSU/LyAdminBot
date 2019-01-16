const mongoose = require('mongoose')


const gifs = [
  'CgADBAAD6XQAAhIZZAdy9bLvfo_v3AI',
  'CgADBAAD2p8AAnsaZAe9U3IPs3ggVQI',
  'CgADBAADqaEAAlcZZAfdQwoo3XgYsgI',
  'CgADAgAD7gEAAkil-UhVJPwkXP9K_AI',
  'CgADBAADxhoAAsUaZAcbKNbmBCPXeAI',
  'CgADBAADpRYAAswdZAdaNtP34Me0UwI',
  'CgADBAADAgEAAh-cYVMQ-Ug8CxUslwI',
  'CgADAgADvQAD4AUwSaQ9EOccXKTtAg',
  'CgADAgADNQADS_BhSFJUMSN9dzA_Ag',
  'CgADAgADHwEAAvB2IUmd4acpN15-6AI',
  'CgADAgADqAEAAmJG2UhWMwcsgE1dJQI',
  'CgADBAADyx4AAhQYZAf23gg3uGzgkAI',
  'CgADAgADLAADqsgYScCP1pLZKHaFAg',
  'CgADBAADa6AAAtIcZAdtsi17FRbkhwI',
  'CgADBAADHdcAAswdZAejeyruW1B6KQI',
  'CgADBAAD5IkBAAEVGGQHRc6-1RnYMCQC',
  'CgADAgADowADW7g4StVCQYMcd9aKAg',
  'CgADAgAD4AEAAlvyUgfKPMTZiuf5vgI',
]

const texts = [
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

const groupSchema = mongoose.Schema({
  group_id: {
    type: Number,
    index: true,
    unique: true,
    required: true,
  },
  title: String,
  username: String,
  settings: {
    welcome: {
      type: Boolean,
      default: true,
    },
    welcome_timer: {
      type: Number,
      default: 180,
    },
    gifs: {
      type: Array,
      default: gifs,
    },
    texts: {
      type: Array,
      default: texts,
    },
  },
  first_act: Number,
  last_act: Number,
})

const Group = mongoose.model('Group', groupSchema)

Group.prototype.dbUpdate = (ctx) => new Promise((resolve, reject) => {
  Group.findOne({ group_id: ctx.chat.id }, (err, doc) => {
    if (err) {
      reject(err)
    }

    // eslint-disable-next-line no-magic-numbers
    const now = Math.floor(new Date().getTime() / 1000)
    let group = doc

    if (!group) {
      group = new Group()

      group.group_id = ctx.chat.id
      group.first_act = now
    }
    group.title = ctx.chat.title
    group.username = ctx.chat.username
    group.settings = group.settings || new Group().settings
    group.last_act = now
    group.save()

    ctx.groupInfo = group

    resolve(group)
  })
})


module.exports = Group
