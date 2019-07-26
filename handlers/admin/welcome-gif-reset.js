module.exports = async (ctx) => {
  ctx.group.info.settings.welcome.gifs = []
  ctx.replyWithHTML(ctx.i18n.t('cmd.gif.reset'))
}
