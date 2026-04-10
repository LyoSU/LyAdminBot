module.exports = async (ctx) => {
  if (ctx.group.info.settings.banDatabase !== false) {
    ctx.group.info.settings.banDatabase = false
    ctx.replyWithHTML(ctx.i18n.t('cmd.banDatabase.disable'))
  } else {
    ctx.group.info.settings.banDatabase = true
    ctx.replyWithHTML(ctx.i18n.t('cmd.banDatabase.enable'))
  }
}
