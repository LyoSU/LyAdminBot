module.exports = async (ctx) => {
  ctx.group.info.settings = new ctx.db.Group().settings
  await ctx.group.info.save()
  await ctx.replyWithHTML(ctx.i18n.t('cmd.reset'))
}
