const {
  loadCanvasImage,
  generateQuote
} = require('../utils')

module.exports = async (ctx) => {
  if (ctx.message.reply_to_message && (ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption)) {
    // set parms
    const replyMessage = ctx.message.reply_to_message

    let text, entities

    if (replyMessage.caption) {
      text = replyMessage.caption
      entities = replyMessage.caption_entities
    } else {
      text = replyMessage.text
      entities = replyMessage.entities
    }

    let messageFrom = replyMessage.from

    if (replyMessage.forward_sender_name) {
      messageFrom = {
        id: 0,
        first_name: replyMessage.forward_sender_name,
        username: 'HiddenSender'
      }
    } else if (replyMessage.forward_from_chat) {
      messageFrom = {
        id: replyMessage.forward_from_chat.id,
        first_name: replyMessage.forward_from_chat.title,
        username: replyMessage.forward_from_chat.username || null
      }
    }

    // ser background color
    let backgroundColor = '#130f1c'

    if (ctx.group && ctx.group.info.settings.quote.backgroundColor) backgroundColor = ctx.group.info.settings.quote.backgroundColor

    if ((ctx.match && ctx.match[2] === 'random') || backgroundColor === 'random') backgroundColor = `#${(Math.floor(Math.random() * 16777216)).toString(16)}`
    else if (ctx.match && ctx.match[1] === '#' && ctx.match[2]) backgroundColor = `#${ctx.match[2]}`
    else if (ctx.match && ctx.match[2]) backgroundColor = `${ctx.match[2]}`

    if (replyMessage.forward_from) messageFrom = replyMessage.forward_from
    let nick = `${messageFrom.first_name} ${messageFrom.last_name || ''}`

    let avatarImage

    try {
      let userPhotoUrl = ''

      if (messageFrom.username) userPhotoUrl = `https://telega.one/i/userpic/320/${messageFrom.username}.jpg`

      const getChat = await ctx.telegram.getChat(messageFrom.id)
      const userPhoto = getChat.photo.small_file_id

      if (userPhoto) userPhotoUrl = await ctx.telegram.getFileLink(userPhoto)

      avatarImage = await loadCanvasImage(userPhotoUrl)
    } catch (error) {
      avatarImage = await loadCanvasImage('./assets/404.png')
    }

    const canvasQuote = await generateQuote(avatarImage, backgroundColor, messageFrom.id, nick, text, entities)

    ctx.replyWithDocument({
      source: canvasQuote,
      filename: 'sticker.webp'
    }, {
      reply_to_message_id: replyMessage.message_id
    })
  }
}
