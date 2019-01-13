const Group = require('../models/group')

module.exports = async (ctx) => {
  if (ctx.message.reply_to_message.text) {
    var text = ctx.message.reply_to_message.text

    Group.findOne({
      'group_id': ctx.chat.id,
      'settings.texts': { $in: [text] }
    }, function (err, doc) {
      if (doc) {
        Group.update(
          { group_id: ctx.chat.id },
          { $pull: { 'settings.texts': text } }, (err, doc) => {
            if (err) return console.log(err)
            ctx.replyWithHTML(
              ctx.i18n.t('cmd.text.pull')
            )
          }
        )
      } else {
        Group.update(
          { group_id: ctx.chat.id },
          { $push: { 'settings.texts': text } }, (err, doc) => {
            if (err) return console.log(err)
            ctx.replyWithHTML(
              ctx.i18n.t('cmd.text.push')
            )
          }
        )
      }
    })
  }
}