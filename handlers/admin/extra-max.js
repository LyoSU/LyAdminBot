module.exports = async (ctx) => {
  let maxExtra = ctx.match[1]

  if (maxExtra < 1) maxExtra = 3

  ctx.group.info.settings.maxExtra = maxExtra
  ctx.replyWithHTML(ctx.i18n.t('cmd.extra.max', { maxExtra }))
}
