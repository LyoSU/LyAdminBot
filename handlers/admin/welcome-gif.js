module.exports = async (ctx) => {
  if (ctx.message.reply_to_message.animation) {
    const gifId = ctx.message.reply_to_message.animation.file_id

    const groupGifs = await ctx.db.Group.findOne({
      group_id: ctx.chat.id,
      'settings.welcome.gifs': { $in: [gifId] },
    }, { 'settings.welcome.$': 1 }).catch(console.log)

    if (groupGifs) {
      await ctx.db.Group.update(
        { group_id: ctx.chat.id },
        { $pull: { 'settings.welcome.gifs': gifId } }
      ).catch(console.log)
      await ctx.replyWithHTML(ctx.i18n.t('cmd.gif.pull')).catch(console.log)
      return
    }

    await ctx.db.Group.update(
      { group_id: ctx.chat.id },
      { $push: { 'settings.welcome.gifs': gifId } }
    ).catch(console.log)
    await ctx.replyWithHTML(ctx.i18n.t('cmd.gif.push')).catch(console.log)
  }
}
