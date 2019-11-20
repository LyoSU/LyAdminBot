module.exports = async (ctx) => {
  console.log(ctx.match)
  let backgroundColor = '#130f1c'
  if (ctx.match && ctx.match[1] === '#' && ctx.match[2]) backgroundColor = `#${ctx.match[2]}`
  else if (ctx.match && ctx.match[2]) backgroundColor = `${ctx.match[2]}`

  ctx.group.info.settings.quote.backgroundColor = backgroundColor
  ctx.replyWithHTML(ctx.i18n.t('cmd.quote.set_back_color', { backgroundColor }))
}
