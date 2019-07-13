const { userName } = require('../utils')


module.exports = async (ctx) => {
  if (ctx.group.info.settings.welcome.enable === true) {
    const { gifs, texts } = ctx.group.info.settings.welcome
    const randomGif = gifs[Math.floor(Math.random() * gifs.length)]
    const randomCaption = texts[Math.floor(Math.random() * texts.length)]
    const message = await ctx.replyWithDocument(
      randomGif,
      {
        reply_to_message_id: ctx.message.message_id,
        caption: randomCaption.replace(
          /%name%/g,
          `<b>${userName(ctx.message.new_chat_member)}</b>`
        ),
        parse_mode: 'HTML',
      },
    )

    setTimeout(() => {
      ctx.deleteMessage(message.message_id)
    }, ctx.group.info.settings.welcome.timer * 1000)
  }
}
