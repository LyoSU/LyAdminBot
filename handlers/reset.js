const Group = require('../models/group')


module.exports = async (ctx) => {
  await Group.update(
    { group_id: ctx.chat.id },
    { settings: new Group().settings }, (err) => {
      if (err) {
        return console.log(err)
      }
      return ctx.replyWithHTML(ctx.i18n.t('cmd.reset'))
    }
  )
}
