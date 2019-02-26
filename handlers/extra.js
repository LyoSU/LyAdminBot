const replicators = require('telegraf/core/replicators')
const Group = require('../models/group')


module.exports = async (ctx) => {
  const extraText = ctx.message.text.slice(1)

  const groupExtra = await Group.findOne({
    group_id: ctx.chat.id,
    'settings.extras.name': extraText,
  }, { 'settings.extras.$': 1 }).catch(console.log)

  const extra = groupExtra.settings.extras[0]

  if (ctx.message.reply_to_message) {
    extra.message.reply_to_message_id = ctx.message.reply_to_message.message_id
  }

  const method = replicators.copyMethods[extra.type]
  const opts = Object.assign({ chat_id: ctx.chat.id }, extra.message)

  ctx.telegram.callApi(method, opts)
}
