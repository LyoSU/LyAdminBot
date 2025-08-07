const Composer = require('telegraf/composer')
const composer = new Composer()

const {
  onlyAdmin,
  onlyGroup
} = require('../../middlewares')

composer.hears('!banChannel', onlyAdmin, async (ctx, next) => {
  if (ctx.group.info.settings.banChannel === true) {
    ctx.group.info.settings.banChannel = false
    await ctx.replyWithHTML(ctx.i18n.t('cmd.banChannel.disable'))
  } else {
    ctx.group.info.settings.banChannel = true
    await ctx.replyWithHTML(ctx.i18n.t('cmd.banChannel.enable'))
  }
})

composer.on('message', async (ctx, next) => {
  if (ctx.message.sender_chat && ctx.group.info.settings.banChannel && !ctx.message.is_automatic_forward) {
    await ctx.deleteMessage()

    return ctx.tg.callApi('banChatSenderChat', {
      chat_id: ctx.chat.id,
      sender_chat_id: ctx.message.sender_chat.id
    })
  }
  return next()
})

module.exports = composer
