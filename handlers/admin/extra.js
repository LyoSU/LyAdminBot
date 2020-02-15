const replicators = require('telegraf/core/replicators')

module.exports = async (ctx) => {
  const extraName = ctx.match[2]

  if (extraName) {
    const groupExtra = ctx.group.info.settings.extras.find((el) => {
      if (el.name.match(new RegExp(`^${extraName}$`, 'i'))) return true
    })

    if (groupExtra) {
      ctx.group.info.settings.extras[groupExtra.__index].remove()
    }

    if (ctx.message.reply_to_message) {
      const replyMessage = ctx.message.reply_to_message
      const extraType = Object.keys(replicators.copyMethods).find((type) => replyMessage[type])
      const extraMessage = replicators[extraType](replyMessage)

      ctx.group.info.settings.extras.push({
        name: extraName,
        type: extraType,
        message: extraMessage
      })

      await ctx.replyWithHTML(ctx.i18n.t('cmd.extra.push', { extraName }))
    } else if (groupExtra) ctx.replyWithHTML(ctx.i18n.t('cmd.extra.pull', { extraName }))
    else ctx.replyWithHTML(ctx.i18n.t('cmd.extra.error.not_found', { extraName }))
  }
}
