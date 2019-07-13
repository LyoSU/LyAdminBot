module.exports = async (ctx) => {
  if (ctx.group.info.settings.welcome.enable === true) {
    ctx.group.info.settings.welcome.enable = false
    ctx.replyWithHTML(ctx.i18n.t('cmd.welcome.disable'))
  }
  else {
    ctx.group.info.settings.welcome.enable = true
    ctx.replyWithHTML(ctx.i18n.t('cmd.welcome.enable'))
  }
  await ctx.group.info.save()
}
