module.exports = async (ctx, next) => {
  const chatMember = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id)
  if (chatMember && (chatMember.status === 'creator' || chatMember.status === 'administrator')) {
    return next()
  }
}
