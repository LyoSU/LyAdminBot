const rp = require('request-promise')


module.exports = async (ctx) => {
  if (ctx.message.forward_from.username === ctx.options.username) {
    const fileUrl = await ctx.telegram.getFileLink(ctx.message.document.file_id)
    const json = await rp(fileUrl)
    const settings = JSON.parse(json)

    ctx.groupInfo.settings = settings
    ctx.groupInfo.save()

    ctx.replyWithHTML(ctx.i18n.t('settings.json.reset'), {
      reply_to_message_id: ctx.message.message_id,
    })
  }
}
