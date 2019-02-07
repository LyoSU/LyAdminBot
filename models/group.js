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
  'CgADAgADvQIAAiGn-Umyk0Nd4ttjkQI',
  'CgADAgADxQIAAgjVOUo6DvvhrWbRYgI',
  'CgADAgADzgEAAvKxMUuaY7hBm-d-0QI',
  'CgADAgADEgQAAmIlWUieyzPo5P_p0wI',
  'CgADAgADDwIAAuzIEUl6Gs9DDZo5ZAI',
  'CgADAgADXgIAAg2O4UojiD7PBnd7OgI',
  'CgADAgADuQIAAkXWQEjVuIABhkyEbQI',
  'CgADAgADXwEAAgLukEkLyvdlM-jfLgI',
  'CgADAgADygIAAi8nCUpmb0xW3_UkQwI',
  'CgADAgADYAADrhgZD2Qj9HOZwItYAg',
  'CgADAgADRwEAAoytQUs8O_VRukQ-4QI',
  'CgADBAADrgADkRZAU4GO6ot6PRXzAg',
  'CgADAgADqwADcPsRENdHoywrOTF6Ag',
]

const texts = [
  'Hi, %name%',
  'Привіт, %name%✌️ Ми чекали лише тебе😘',
  'О, %name%. Ты где пропадал? Тебя только ждали.',
  '%name%, добро пожаловать в нашу компанию 🤜🏻🤛🏿',
  '%name%, приветствуем в нашем царстве👑',
  'Добрий день, %name%, не журися, козаче, тепер ти з нами😱',
  '%name%, яке щастя, що ти тепер з нами!',
  'Hisashiburi desu, %name% ✌',
  'Yahhoo %name% 🙋🏻',
  '%name%, устраивайся поудобнее😉',
  'Вы посмотрите😲 Это же %name%!',
  '%name%, ну и что ты тут забыл?😒',
  '%name%, за вход передаем!',
  'Кто разрешил сюда зайти %name% ?🤔',
  '%name% няша😘',
  'Поприветствуйте %name% 🙋🏼‍♂️',
  '%name%, а кто это такой к нам пришел? 😲',
  '%name%, мяу😽',
  '👏🏻 AYAYA %name% 😝',
  'Зачем вы позвали %name%? Этот человек мне нравится...',
  'В нашем чате новичок! %name%, проходи ❤️',
  'Сюда зашёл лучший человек в мире — %name%. Слушай, мы тебя любим и готовы общаться, но ты просто веди себя хорошо, чтобы избежать наказаний',
  'У меня было ужасное настроение, но к нам пожаловала няха с ником %name% и мне стало легче! ❤️',
  'Эх, сейчас бы пообщаться... %name%, расскажи о себе!',
  'На улице Рейн,\nНа душе Пейн,\nА настроение улучшается во время общения с %name%!',
  '%name%, посоветуешь музыку? 🤔',
  '%name%, ты вошёл в дом нашей банды и не поприветствовал нас? 😡',
  'Математик, анимешник и просто хороший человек %name%, приветствуйте!',
  'Вы опять нарушили, являясь самым милым существом в этом чате! %name%, на этот раз штраф — обнимашки. Впредь будьте бдительны!',
  '%name%, ДАРОВА ТВАРЫНА',
  'Да благословит тебя Павел Дуров, %name%! Ты избранный — вступил в банду. Ждём интересные истории!',
  '2+3=5. Я+%name%=❤️',
  'Беда... Я слишком взволнован появлением %name% в рядах наших ребят... Хочу обнять эту няху, но не могу...',
  '%name%, ты ведь любишь меня? Я тебя — да!',
  'Хватит смотреть котят в интернете, когда есть %name%!',
  'За аниме и музыку ломаю лицо, а вот за банду и %name% — ломаю жизнь',
  'Кто-то читает книги, кто-то смотрит кино. Но вот мне нравится общаться с %name% ❤️',
  'В очередной раз убеждаюсь, что появление %name% в разы увеличивает колличество ударов моего сердечка, но никому не говорите!',
  'Вчера я купил две мороженые. Одну для себя, а вторую для %name%. Я свою съел. Мороженку %name% тоже съел. Не осуждайте',
  'Хватит навязывать мне отношения! Я всем сердечком люблю %name%!',
  'Слушай, %name%, не трудно ли тебе полюбить меня? 😳',
  'Есть, значит, два стула. На какой, %name%, сам сядешь, а на какой чат посадишь?',
  'А снится нам не рокот космодрома, не эта ледяная синева, а снится нам личико %name% 😍',
  'Когда мне больно, когда мне темно, я обнимаюсь с %name%!',
  '%name% — это звучит гордо!',
  'Давай, %name%, пиши. Зачем мне этот чат, если в нём не будет тебя?',
  'Иногда без причины хочется к морю, а сейчас мне хочется к %name%!',
  'Мы две Кореи... Ты, %name%, Юг, я — север. Друг в друга целим, а были целым. Давай просто дружить!',
  'Я опять сплю? Теперь с нами %name%? Блин, надо показать себя с лучшей стороны. Привет!',
  'Чат замер в ожидании первого сообщения от %name%! Пиши, не нужно стесняться!❤️',
  'Нам с тобой, %name%, не очень везёт. Нас любят одинаково сильно!',
  'Алё, %name%, а где поднять бабла?',
  'Я ненавижу реп и плохое настроение у %name%! Если на первый пункт мне уже плевать, то второй сейчас решим! Давай, подходи ко мне... ❤️',
]

const memberSchema = mongoose.Schema({
  _id: {
    type: Number,
    index: true,
    unique: true,
    required: true,
    sparse: true,
  },
  banan: {
    num: {
      type: Number,
      default: 0,
    },
    sum: {
      type: Number,
      default: 0,
    },
    stack: {
      type: Number,
      default: 0,
    },
    last: {
      who: Number,
      how: Number,
      time: Number,
    },
  },
  first_act: Number,
  last_act: Number,
}, { _id: false })

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
      enable: {
        type: Boolean,
        default: true,
      },
      timer: {
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
    banan: {
      default: {
        type: Number,
        default: 300,
      },
    },
    extras: [{
      name: String,
      content: String,
    }],
  },
  members: [memberSchema],
  first_act: Number,
  last_act: Number,
})

const Group = mongoose.model('Group', groupSchema)

Group.dbUpdate = (ctx) => new Promise(async (resolve, reject) => {
  let group = await Group.findOne({
    group_id: ctx.chat.id,
  }).catch(reject)

  const now = Math.floor(new Date().getTime() / 1000)

  if (!group) {
    group = new Group()
    group.group_id = ctx.chat.id
    group.first_act = now
  }

  group.title = ctx.chat.title
  group.username = ctx.chat.username
  group.settings = group.settings || new Group().settings
  group.last_act = now

  let member = await group.members.id(ctx.from.id)

  if (!member) {
    await group.members.push({
      _id: ctx.from.id,
      last_act: now,
      first_act: now,
    })
    member = group.members.id(ctx.from.id)
  }

  member.last_act = now

  await group.save()

  ctx.groupInfo = group
  ctx.groupMemberInfo = member

  resolve(group)
})


module.exports = Group
