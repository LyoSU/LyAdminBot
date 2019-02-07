module.exports = async (ctx) => {
  console.log(ctx.groupInfo)
  if (ctx.groupInfo.settings.welcome.enable === true) {
    ctx.groupInfo.settings.welcome.enable = false
    ctx.replyWithHTML(ctx.i18n.t('cmd.welcome.disable'))
  }
  else {
    ctx.groupInfo.settings.welcome.enable = true
    ctx.replyWithHTML(ctx.i18n.t('cmd.welcome.enable'))
  }
  await ctx.groupInfo.save()
}
