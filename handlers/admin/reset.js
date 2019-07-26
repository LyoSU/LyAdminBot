module.exports = async (ctx) => {
  await ctx.db.Group.update(
    { group_id: ctx.chat.id },
    { settings: new ctx.db.Group().settings }, (err) => {
      if (err) {
        console.log(err)
      }
      ctx.replyWithHTML(ctx.i18n.t('cmd.reset'))
    }
  )
}
