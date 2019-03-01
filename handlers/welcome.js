const { userName } = require('../utils')


module.exports = async (ctx) => {
  if (ctx.groupInfo.settings.welcome.enable === true) {
    const { gifs, texts } = ctx.groupInfo.settings.welcome
    const randomGif = gifs[Math.floor(Math.random() * gifs.length)]
    const randomCaption = texts[Math.floor(Math.random() * texts.length)]
    const message = await ctx.replyWithDocument(
      randomGif,
      {
        caption: randomCaption.replace(
          /%name%/g,
          `<b>${userName(ctx.message.new_chat_member)}</b>`
        ),
        parse_mode: 'HTML',
      },
    )

    setTimeout(() => {
      ctx.deleteMessage(message.message_id)
    }, ctx.groupInfo.settings.welcome.timer * 1000)
  }
}
