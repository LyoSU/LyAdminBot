module.exports = async (ctx) => {
  let extras = ''

  await ctx.groupInfo.settings.extras.forEach((extra) => {
    extras += `#${extra.name} `
  })

  ctx.replyWithHTML(ctx.i18n.t('cmd.extras.list', { extras }))
}
