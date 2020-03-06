const { userName } = require('../utils')

module.exports = async (ctx) => {
  if (ctx.group.info.settings.welcome.enable === true) {
    const { gifs, texts } = ctx.group.info.settings.welcome
    const randomGif = gifs[Math.floor(Math.random() * gifs.length)]
    let randomCaption = ''
    if (texts.length > 0) randomCaption = texts[Math.floor(Math.random() * texts.length)]

    let message

    if (randomGif) {
      message = await ctx.replyWithDocument(
        randomGif,
        {
          reply_to_message_id: ctx.message.message_id,
          caption: randomCaption.replace(
            /%name%/g,
            `<b>${userName(ctx.message.new_chat_member)}</b>`
          ),
          parse_mode: 'HTML'
        }
      )
    } else if (randomCaption.length > 0) {
      message = await ctx.replyWithHTML(randomCaption.replace(
        /%name%/g,
        `<b>${userName(ctx.message.new_chat_member)}</b>`
      ), {
        reply_to_message_id: ctx.message.message_id,
        parse_mode: 'HTML'
      })
    }

    if (message) {
      setTimeout(() => {
        ctx.deleteMessage(message.message_id)
      }, ctx.group.info.settings.welcome.timer * 1000)
    }
  }
}
