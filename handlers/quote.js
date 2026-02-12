const { btnIcons } = require('../helpers/emoji-map')

module.exports = async (ctx) => {
  const quoteBot = await ctx.getChatMember(1031952739).catch(() => {})
  if (quoteBot && !['member', 'administrator'].includes(quoteBot.status)) {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.quote'), {
      reply_to_message_id: ctx.message.message_id,
      reply_markup: {
        inline_keyboard: [[
          {
            text: ctx.i18n.t('private.btn_add'),
            url: 'https://t.me/QuotLyBot?startgroup=add',
            icon_custom_emoji_id: btnIcons.addToGroup
          }
        ]]
      }
    })
  }
}
