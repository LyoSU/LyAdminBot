module.exports = async (ctx) => {
  let result = ctx.i18n.t('cmd.extras.error.not_found')

  if (ctx.group.info.settings.extras.length > 0) {
    let extras = ''

    ctx.group.info.settings.extras.forEach((extra) => {
      extras += `#${extra.name} `
    })
    result = ctx.i18n.t('cmd.extras.list', { extras })
  }

  ctx.replyWithHTML(result, {
    reply_to_message_id: ctx.message.message_id,
  })
}
