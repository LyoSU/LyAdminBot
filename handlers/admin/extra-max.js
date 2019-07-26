module.exports = async (ctx) => {
  const maxExtra = ctx.match[1]

  ctx.group.info.settings.maxExtra = maxExtra
  ctx.replyWithHTML(ctx.i18n.t('cmd.extra.max', { maxExtra }))
}
