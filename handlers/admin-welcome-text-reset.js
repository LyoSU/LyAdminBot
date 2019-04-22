module.exports = async (ctx) => {
  ctx.groupInfo.settings.welcome.texts = []
  ctx.groupInfo.save()
  ctx.replyWithHTML(ctx.i18n.t('cmd.text.reset'))
}
