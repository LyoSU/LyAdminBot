const Group = require('../models/group')


module.exports = async (ctx) => {
  const extraText = ctx.message.text.slice(1)

  const groupExtra = await Group.findOne({
    group_id: ctx.chat.id,
    'settings.extras.name': extraText,
  }, { 'settings.extras.$': 1 }).catch(console.log)

  ctx.replyWithHTML(groupExtra.settings.extras[0].content)
}
