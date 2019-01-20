const Group = require('../models/group')


module.exports = async (ctx) => {
  const arg = ctx.message.text.split(/ +/)

  if (arg[1]) {
    const group = await Group.findOne({
      group_id: ctx.chat.id,
      'settings.extras.name': arg[1],
    }).catch(console.log)

    if (group) {
      group.settings.extras.remove()
      group.save()
      ctx.replyWithHTML(ctx.i18n.t('cmd.extra.pull'))
      return
    }

    if (ctx.message.reply_to_message.text) {
      await Group.update(
        { group_id: ctx.chat.id },
        {
          $push: {
            'settings.extras': {
              name: arg[1],
              content: ctx.message.reply_to_message.text,
            },
          },
        }
      ).catch(console.log)
      await ctx.replyWithHTML(ctx.i18n.t('cmd.extra.push')).catch(console.log)
    }
  }
}
