module.exports = async (ctx, next) => {
  const member = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id)
  if (member && (member.status === 'creator' || member.status === 'administrator')) {
    return next()
  }
}