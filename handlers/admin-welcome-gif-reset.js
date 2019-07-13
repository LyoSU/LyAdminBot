module.exports = async (ctx) => {
  ctx.group.info.settings.welcome.gifs = []
  ctx.group.info.save()
  ctx.replyWithHTML(ctx.i18n.t('cmd.gif.reset'))
}
