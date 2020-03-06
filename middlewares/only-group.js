module.exports = (ctx, next) => {
  if (['supergroup', 'group'].includes(ctx.chat.type)) {
    return next()
  }
}
