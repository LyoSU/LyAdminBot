const replicators = require('telegraf/core/replicators')


module.exports = async (ctx) => {
  const arg = ctx.message.text.split(/ +/)
  const extraName = arg[1]

  if (extraName) {
    const groupExtra = await ctx.db.Group.findOne({
      group_id: ctx.chat.id,
      'settings.extras.name': extraName,
    }, { 'settings.extras.$': 1 }).catch(console.log)

    if (groupExtra) {
      groupExtra.settings.extras[0].remove()
      groupExtra.save()
    }

    if (ctx.message.reply_to_message) {
      const replyMessage = ctx.message.reply_to_message
      const extraType = Object.keys(replicators.copyMethods).find((type) => replyMessage[type])
      const extraMessage = replicators[extraType](replyMessage)

      await ctx.db.Group.update(
        { group_id: ctx.chat.id },
        {
          $push: {
            'settings.extras': {
              name: extraName,
              type: extraType,
              message: extraMessage,
            },
          },
        }
      ).catch(console.log)
      await ctx.replyWithHTML(ctx.i18n.t('cmd.extra.push', { extraName }))
    }
    else if (groupExtra) ctx.replyWithHTML(ctx.i18n.t('cmd.extra.pull', { extraName }))
    else ctx.replyWithHTML(ctx.i18n.t('cmd.extra.error.not_found', { extraName }))
  }
}
