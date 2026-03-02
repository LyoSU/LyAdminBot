const { userName } = require('../utils')
const { scheduleDeletion } = require('../helpers/message-cleanup')

module.exports = async (ctx) => {
  if (ctx.group.info.settings.welcome.enable !== true) return

  const { gifs, texts } = ctx.group.info.settings.welcome
  const validGifs = (gifs || []).filter(Boolean)
  const validTexts = (texts || []).filter(Boolean)

  const randomGif = validGifs.length > 0
    ? validGifs[Math.floor(Math.random() * validGifs.length)]
    : null
  const randomCaption = validTexts.length > 0
    ? validTexts[Math.floor(Math.random() * validTexts.length)]
    : ''

  const memberName = `<b>${userName(ctx.message.new_chat_member)}</b>`
  const caption = randomCaption.replace(/%name%/g, memberName)

  let message

  if (randomGif) {
    message = await ctx.replyWithDocument(randomGif, {
      reply_to_message_id: ctx.message.message_id,
      caption,
      parse_mode: 'HTML'
    })
  } else if (caption.length > 0) {
    message = await ctx.replyWithHTML(caption, {
      reply_to_message_id: ctx.message.message_id
    })
  }

  if (message && ctx.db) {
    const delayMs = ctx.group.info.settings.welcome.timer * 1000
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: message.message_id,
      delayMs,
      source: 'cmd_welcome'
    }, ctx.telegram)
  }
}
