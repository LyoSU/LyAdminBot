module.exports = async (ctx) => {
  if (ctx.message.reply_to_message.animation) {
    const gifId = ctx.message.reply_to_message.animation.file_id

    const groupGifs = ctx.group.info.settings.welcome.gifs.findIndex((el) => {
      if (el === gifId) return true
    })

    if (groupGifs < 0) {
      ctx.group.info.settings.welcome.gifs.push(gifId)
      ctx.replyWithHTML(ctx.i18n.t('cmd.gif.push')).catch(console.log)
      return
    }

    const gifIndex = ctx.group.info.settings.welcome.gifs.indexOf(gifId)

    ctx.group.info.settings.welcome.gifs.splice(gifIndex, 1)
    ctx.replyWithHTML(ctx.i18n.t('cmd.gif.pull')).catch(console.log)
  }
}
