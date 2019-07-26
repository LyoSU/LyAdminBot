const https = require('https')


module.exports = async (ctx) => {
  if (
    ctx.message.forward_from
    && ctx.message.forward_from.username === ctx.options.username
    && ctx.message.document
    && ctx.message.document.mime_type === 'application/json'
  ) {
    const fileUrl = await ctx.telegram.getFileLink(ctx.message.document.file_id)

    https.get(fileUrl, (response) => {
      let json = ''

      response.on('data', (chunk) => {
        json += chunk
      })

      response.on('end', () => {
        const settings = JSON.parse(json)

        ctx.group.info.settings = settings

        ctx.replyWithHTML(ctx.i18n.t('settings.json.reset'), {
          reply_to_message_id: ctx.message.message_id,
        })
      })
    })
  }
}
