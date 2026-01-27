const https = require('https')

const getFile = (url) => {
  return new Promise((resolve) => {
    https.get(url, (response) => {
      let data = ''

      response.on('data', (chunk) => {
        data += chunk
      })

      response.on('end', () => {
        resolve(data)
      })
    })
  })
}

module.exports = async (ctx) => {
  let chatMember
  try {
    chatMember = await ctx.tg.getChatMember(
      ctx.message.chat.id,
      ctx.message.from.id
    )
  } catch (err) {
    // Bot is not admin in this chat, can't check member status
    return
  }

  if (
    ['creator', 'administrator'].includes(chatMember.status) &&
    ctx.message.forward_from &&
    ctx.message.forward_from.username === ctx.options.username &&
    ctx.message.document &&
    ctx.message.document.mime_type === 'application/json'
  ) {
    const fileUrl = await ctx.telegram.getFileLink(ctx.message.document.file_id)

    const settings = JSON.parse(await getFile(fileUrl))

    ctx.group.info.settings = settings
    await ctx.group.info.save()

    await ctx.replyWithHTML(ctx.i18n.t('settings.json.reset'), {
      reply_to_message_id: ctx.message.message_id
    })
  }
}
