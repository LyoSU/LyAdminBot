module.exports = async (ctx) => {
  ctx.mixpanel.track('new member')
  var gifs = ctx.groupInfo.settings.gifs
  var randomGif = gifs[Math.floor(Math.random() * gifs.length)]
  var texts = ctx.groupInfo.settings.texts
  var randomCaption = texts[Math.floor(Math.random() * texts.length)]
  const message = await ctx.replyWithDocument(
    randomGif,
    { 'caption': randomCaption.replace('%login%', userLogin(ctx.from)) }
  )
  setTimeout(() => {
    ctx.deleteMessage(message.message_id)
  }, 60000)
}
