const Markup = require('telegraf/markup')


module.exports = async (ctx) => {
  const locales = {
    ru: '🇷🇺',
    uk: '🇺🇦',
  }

  if (ctx.updateType === 'callback_query') {
    if (locales[ctx.match[1]]) {
      if (['supergroup', 'group'].includes(ctx.chat.type)) {
        const chatMember = await ctx.tg.getChatMember(
          ctx.callbackQuery.message.chat.id,
          ctx.callbackQuery.message.from.id
        )

        if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
          ctx.answerCbQuery(locales[ctx.match[1]])
          ctx.groupInfo.settings.locale = ctx.match[1]
          ctx.groupInfo.save()
        }
        else {
          ctx.answerCbQuery()
        }
      }
      else {
        ctx.answerCbQuery(locales[ctx.match[1]])

        ctx.userInfo.locale = ctx.match[1]
        ctx.userInfo.save()
      }
    }
  }
  else {
    const button = []

    Object.keys(locales).map((key) => {
      button.push(Markup.callbackButton(locales[key], `set_language:${key}`))
    })

    ctx.reply('🇷🇺 Выберите язык\n🇺🇸 Choose language', {
      reply_markup: Markup.inlineKeyboard(button, {
        columns: 3,
      }),
    })
  }
}
