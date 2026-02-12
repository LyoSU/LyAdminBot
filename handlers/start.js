const { userName } = require('../utils')
const { btnIcons } = require('../helpers/emoji-map')

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
      {
        reply_markup: {
          inline_keyboard: [[
            {
              text: ctx.i18n.t('private.btn_add'),
              url: `https://t.me/${ctx.botInfo.username}?startgroup=add`,
              icon_custom_emoji_id: btnIcons.addToGroup
            }
          ]]
        }
      }
    )
  } else {
    // Group chat - short info about the bot
    await ctx.replyWithHTML(ctx.i18n.t('group.start'))
  }
}
