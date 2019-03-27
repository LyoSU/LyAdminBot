module.exports = async (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.help'), {
  reply_to_message_id: ctx.message.message_id,
})
