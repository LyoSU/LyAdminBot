const Extra = require('telegraf/extra')
const { userName } = require('../utils')

/**
 * Handle /start command in both private and group chats
 */
module.exports = async (ctx) => {
  const isPrivate = ctx.chat.type === 'private'

  if (isPrivate) {
    // Private chat - show full welcome with "Add to group" button
    await ctx.replyWithHTML(
      ctx.i18n.t('private.start', {
        name: userName(ctx.from)
      }),
      Extra.HTML().markup((m) => m.inlineKeyboard([
        m.urlButton(
          ctx.i18n.t('private.btn_add'),
          `https://t.me/${ctx.botInfo.username}?startgroup=add`
        )
      ]))
    )
  } else {
    // Group chat - short info about the bot
    await ctx.replyWithHTML(ctx.i18n.t('group.start'))
  }
}
