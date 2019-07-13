module.exports = async (ctx) => {
  ctx.group.info.settings.welcome.texts = []
  ctx.group.info.save()
  ctx.replyWithHTML(ctx.i18n.t('cmd.text.reset'))
}
