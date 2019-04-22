module.exports = async (ctx) => {
  ctx.groupInfo.settings.welcome.gifs = []
  ctx.groupInfo.save()
  ctx.replyWithHTML(ctx.i18n.t('cmd.gif.reset'))
}
