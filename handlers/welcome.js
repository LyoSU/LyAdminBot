const { userLogin } = require('../lib')


module.exports = async (ctx) => {
  ctx.mixpanel.track('new member')
  const { gifs, texts } = ctx.groupInfo.settings
  const randomGif = gifs[Math.floor(Math.random() * gifs.length)]
  const randomCaption = texts[Math.floor(Math.random() * texts.length)]
  const message = await ctx.replyWithDocument(
    randomGif,
    {
      caption: randomCaption.replace(
        '%login%',
        `<b>${userLogin(ctx.from)}</b>`
      ),
      parse_mode: 'HTML',
    },
  )

  setTimeout(() => {
    ctx.deleteMessage(message.message_id)
  }, ctx.groupInfo.settings.welcome_timer * 1000)
}
