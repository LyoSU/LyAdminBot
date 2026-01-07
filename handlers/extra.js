const replicators = require('telegraf/core/replicators')
const { escapeRegex } = require('../utils')

module.exports = async (ctx) => {
  const entities = ctx.message.entities || []
  const { maxExtra } = ctx.group.info.settings
  let entitiesNum = entities.length
  let hashtagNum = 0

  if (entitiesNum > maxExtra) entitiesNum = maxExtra

  for (let index = 0; index < entities.length; index++) {
    const entity = entities[index]

    if (hashtagNum < entitiesNum && entity.type === 'hashtag') {
      const hashtag = ctx.message.text.substring(entity.offset, entity.offset + entity.length)
      const safeHashtag = escapeRegex(hashtag.slice(1))
      const groupExtra = ctx.group.info.settings.extras.find((el) => {
        if (el.name.match(new RegExp(`^${safeHashtag}$`, 'i'))) return true
      })

      if (groupExtra) {
        if (ctx.message.reply_to_message) groupExtra.message.reply_to_message_id = ctx.message.reply_to_message.message_id
        else groupExtra.message.reply_to_message_id = ctx.message.message_id

        const method = replicators.copyMethods[groupExtra.type]
        const opts = Object.assign({ chat_id: ctx.chat.id }, groupExtra.message)

        await ctx.telegram.callApi(method, opts)

        hashtagNum++
      }
    }
  }
}
