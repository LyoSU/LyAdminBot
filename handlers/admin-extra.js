const Group = require('../models/group')


module.exports = async (ctx) => {
  const arg = ctx.message.text.split(/ +/)
  const extraName = arg[1]

  if (extraName) {
    const groupExtra = await Group.findOne({
      group_id: ctx.chat.id,
      'settings.extras.name': extraName,
    }, { 'settings.extras.$': 1 }).catch(console.log)

    if (groupExtra) {
      groupExtra.settings.extras[0].remove()
      groupExtra.save()
    }

    if (ctx.message.reply_to_message) {
      await Group.update(
        { group_id: ctx.chat.id },
        {
          $push: {
            'settings.extras': {
              name: extraName,
              content: ctx.message.reply_to_message.text,
            },
          },
        }
      ).catch(console.log)
      if (groupExtra) await ctx.replyWithHTML(ctx.i18n.t('cmd.extra.update', { extraName }))
      else await ctx.replyWithHTML(ctx.i18n.t('cmd.extra.push', { extraName }))
    }
    else if (groupExtra) ctx.replyWithHTML(ctx.i18n.t('cmd.extra.pull', { extraName }))
    else ctx.replyWithHTML(ctx.i18n.t('cmd.extra.error.not_found', { extraName }))
  }
}
