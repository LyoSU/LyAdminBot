module.exports = async (ctx) => {
  let backgroundColor = ctx.match[2]

  ctx.group.info.settings.quote.backgroundColor = backgroundColor
  ctx.replyWithHTML(ctx.i18n.t('cmd.quote.set_back_color', { backgroundColor }))
}
