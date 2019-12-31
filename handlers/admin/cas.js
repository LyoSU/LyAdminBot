module.exports = async (ctx) => {
  if (ctx.group.info.settings.cas === true) {
    ctx.group.info.settings.cas = false
    ctx.replyWithHTML(ctx.i18n.t('cmd.cas.disable'))
  } else {
    ctx.group.info.settings.cas = true
    ctx.replyWithHTML(ctx.i18n.t('cmd.cas.enable'))
  }
}
