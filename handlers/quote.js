module.exports = async (ctx) => {
  const quoteBot = await ctx.getChatMember(1031952739)
  if (!['member', 'administrator'].includes(quoteBot.status)) {
    ctx.replyWithHTML(ctx.i18n.t('cmd.quote'), {
      reply_to_message_id: ctx.message.message_id
    })
  }
}
