module.exports = async (ctx) => {
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const { text } = ctx.message.reply_to_message

    if (text.indexOf('%name%') !== -1) {
      const groupText = ctx.group.info.settings.welcome.texts.findIndex((el) => {
        if (el === text) return true
      })

      if (groupText < 0) {
        ctx.group.info.settings.welcome.texts.push(text)
        ctx.replyWithHTML(ctx.i18n.t('cmd.text.push'))
        return
      }

      delete ctx.group.info.settings.welcome.texts[groupText]
      ctx.replyWithHTML(ctx.i18n.t('cmd.text.pull'))
    } else {
      ctx.replyWithHTML(ctx.i18n.t('cmd.text.error'))
    }
  }
}
