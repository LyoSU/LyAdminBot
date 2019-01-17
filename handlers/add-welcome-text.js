const Group = require('../models/group')


module.exports = async (ctx) => {
  if (ctx.message.reply_to_message.text) {
    const { text } = ctx.message.reply_to_message

    if (text.indexOf('%login%') !== -1) {
      Group.findOne({
        group_id: ctx.chat.id,
        'settings.texts': { $in: [text] },
      }, (err, doc) => {
        if (doc) {
          Group.update(
            { group_id: ctx.chat.id },
            { $pull: { 'settings.texts': text } },
            (err1) => {
              if (err1) {
                return console.log(err1)
              }
              return ctx.replyWithHTML(ctx.i18n.t('cmd.text.pull'))
            }
          )
        }
        else {
          Group.update(
            { group_id: ctx.chat.id },
            { $push: { 'settings.texts': text } }, (err1) => {
              if (err1) {
                return console.log(err1)
              }
              return ctx.replyWithHTML(ctx.i18n.t('cmd.text.push'))
            }
          )
        }
      })
    }
    else {
      ctx.replyWithHTML(ctx.i18n.t('cmd.text.error'))
    }
  }
}
