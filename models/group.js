const mongoose = require('mongoose')

const gifs = ['CgADAgADqAEAAmJG2Uglzd9EwW55bwI', 'CgADBAADyx4AAhQYZAetvXlEFn5cswI', 'CgADBAAD2p8AAnsaZAcJm0k7V_kXNAI', 'CgADAgADNQADS_BhSDpVCwqAH-ApAg', 'CgADAgADHwEAAvB2IUlCVQ-SgmWrHgI', 'CgADAgADowADW7g4StIu7SVZ0yipAg', 'CgADBAAD6XQAAhIZZAeTavEu0igaiAI', 'CgADAgADvQAD4AUwSQS5MUl_EGsyAg', 'CgADAgAD4AEAAlvyUgd71fE8N2Hk_QI', 'CgADBAADqaEAAlcZZAfGeJGIyZqlewI', 'CgADBAAD5IkBAAEVGGQH0W-_EJ5srcIC', 'CgADAgADLAADqsgYSR_BdlF8KTJMAg', 'CgADBAADa6AAAtIcZActYXkQawyAOgI', 'CgADBAADHdcAAswdZAcu3MWguaCW-AI', 'CgADBAADpRYAAswdZAcpeGLhy5LTGQI', 'CgADBAADxhoAAsUaZAfJ7wp8FdS2xQI', 'CgADAgAD7gEAAkil-UjXyAw0cwaZWgI', 'CgADBAADAgEAAh-cYVNbj7BOYD9JtgI']

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
  '👏🏻 AYAYA %login% 😝'
]

const groupSchema = mongoose.Schema({
  group_id: { type: Number, index: true, unique: true },
  title: String,
  settings: {
    welcome: {
      type: Boolean,
      default: true
    },
    welcome_timer: {
      type: Number,
      default: 180
    },
    gifs: {
      type: Array,
      default: gifs
    },
    texts: {
      type: Array,
      default: texts
    }
  },
  first_act: Number,
  last_act: Number
})

const Group = mongoose.model('Group', groupSchema)

module.exports = Group
