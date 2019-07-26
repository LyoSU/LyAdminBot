const replicators = require('telegraf/core/replicators')


module.exports = async (ctx, next) => {
  const { entities } = ctx.message
  const { maxExtra } = ctx.group.info.settings
  let num = entities.length

  if (num > maxExtra) num = maxExtra
  for (let index = 0; index < num; index++) {
    const entity = entities[index]

    if (entity.type === 'hashtag') {
      const hashtag = ctx.message.text.substring(entity.offset, entity.offset + entity.length)
      const groupExtra = ctx.group.info.settings.extras.find((el) => {
        if (el.name.match(new RegExp(`^${hashtag.slice(1)}`, 'i'))) return true
      })

      if (groupExtra) {
        if (ctx.message.reply_to_message) groupExtra.message.reply_to_message_id = ctx.message.reply_to_message.message_id
        else groupExtra.message.reply_to_message_id = ctx.message.message_id

        const method = replicators.copyMethods[groupExtra.type]
        const opts = Object.assign({ chat_id: ctx.chat.id }, groupExtra.message)

        await ctx.telegram.callApi(method, opts)
      }
      else {
        next()
      }
    }
  }
}
