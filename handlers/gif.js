const Group = require('../models/group')

module.exports = async (ctx) => {
  if (ctx.message.reply_to_message.animation) {
    var gifId = ctx.message.reply_to_message.animation.file_id

    Group.findOne({
      'group_id': ctx.chat.id,
      'settings.gifs': { $in: [gifId] }
    }, function (err, doc) {
      if (doc) {
        Group.update(
          { group_id: ctx.chat.id },
          { $pull: { 'settings.gifs': gifId } }, (err, doc) => {
            if (err) return console.log(err)
            ctx.replyWithHTML(
              ctx.i18n.t('welcome.gif.pull')
            )
          }
        )
      } else {
        Group.update(
          { group_id: ctx.chat.id },
          { $push: { 'settings.gifs': gifId } }, (err, doc) => {
            if (err) return console.log(err)
            ctx.replyWithHTML(
              ctx.i18n.t('welcome.gif.push')
            )
          }
        )
      }
    })
  }
}
