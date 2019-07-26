module.exports = async (ctx) => {
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const { text } = ctx.message.reply_to_message

    if (text.indexOf('%name%') !== -1) {
      const groupText = ctx.group.info.settings.welcome.texts.indexOf('%name% hi')

      console.log(groupText)

      if (groupText) {
        await ctx.db.Group.update(
          { group_id: ctx.chat.id },
          { $pull: { 'settings.welcome.texts': text } }
        ).catch(console.log)
        ctx.replyWithHTML(ctx.i18n.t('cmd.text.pull'))
        return
      }

      await ctx.db.Group.update(
        { group_id: ctx.chat.id },
        { $push: { 'settings.welcome.texts': text } }
      ).catch(console.log)
      ctx.replyWithHTML(ctx.i18n.t('cmd.text.push'))
    }
    else {
      ctx.replyWithHTML(ctx.i18n.t('cmd.text.error'))
    }
  }
}
