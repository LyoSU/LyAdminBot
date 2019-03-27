module.exports = async (ctx) => {
  if (ctx.groupInfo.settings.extras.length > 0) {
    let extras = ''

    await ctx.groupInfo.settings.extras.forEach((extra) => {
      extras += `#${extra.name} `
    })

    ctx.replyWithHTML(ctx.i18n.t('cmd.extras.list', { extras }), {
      reply_to_message_id: ctx.message.message_id,
    })
  }
  else {
    ctx.replyWithHTML(ctx.i18n.t('cmd.extras.error.not_found'), {
      reply_to_message_id: ctx.message.message_id,
    })
  }
}
