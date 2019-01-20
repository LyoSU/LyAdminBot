const Group = require('../models/group')


module.exports = async (ctx) => {
  if (ctx.message.reply_to_message.animation) {
    const gifId = ctx.message.reply_to_message.animation.file_id

    const group = await Group.findOne({
      group_id: ctx.chat.id,
      'settings.welcome.gifs': { $in: [gifId] },
    }).catch(console.log)

    if (group) {
      await Group.update(
        { group_id: ctx.chat.id },
        { $pull: { 'settings.welcome.gifs': gifId } }
      ).catch(console.log)
      await ctx.replyWithHTML(ctx.i18n.t('cmd.gif.pull')).catch(console.log)
      return
    }

    await Group.update(
      { group_id: ctx.chat.id },
      { $push: { 'settings.welcome.gifs': gifId } }
    ).catch(console.log)
    await ctx.replyWithHTML(ctx.i18n.t('cmd.gif.push')).catch(console.log)
  }
}
