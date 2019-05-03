const replicators = require('telegraf/core/replicators')


module.exports = async (ctx, next) => {
  const { entities } = ctx.message
  const { maxExtra } = ctx.groupInfo.settings
  let num = entities.length

  if (num > maxExtra) num = maxExtra
  for (let index = 0; index < num; index++) {
    const entity = entities[index]

    if (entity.type === 'hashtag') {
      const hashtag = ctx.message.text.substring(entity.offset, entity.offset + entity.length)

      const groupExtra = await ctx.db.Group.findOne({
        group_id: ctx.chat.id,
        'settings.extras.name': { $regex: `^${hashtag.slice(1)}$`, $options: 'i' },
      }, { 'settings.extras.$': 1 }).catch(console.log)

      if (groupExtra) {
        const extra = groupExtra.settings.extras[0]

        // eslint-disable-next-line max-len
        if (ctx.message.reply_to_message) extra.message.reply_to_message_id = ctx.message.reply_to_message.message_id
        else extra.message.reply_to_message_id = ctx.message.message_id

        const method = replicators.copyMethods[extra.type]
        const opts = Object.assign({ chat_id: ctx.chat.id }, extra.message)

        ctx.telegram.callApi(method, opts)
      }
      else {
        next()
      }
    }
  }
}
