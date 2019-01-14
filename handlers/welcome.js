const { userLogin } = require('../lib')

module.exports = async (ctx) => {
  ctx.mixpanel.track('new member')
  var gifs = ctx.groupInfo.settings.gifs
  var randomGif = gifs[Math.floor(Math.random() * gifs.length)]
  var texts = ctx.groupInfo.settings.texts
  var randomCaption = texts[Math.floor(Math.random() * texts.length)]
  const message = await ctx.replyWithDocument(
    randomGif,
    { 'caption': randomCaption.replace('%login%', `<b>${userLogin(ctx.from)}</b>`) },
    {parse_mode: 'HTML'}
  )
  setTimeout(() => {
    ctx.deleteMessage(message.message_id)
  }, ctx.groupInfo.settings.welcome_timer * 1000)
}
