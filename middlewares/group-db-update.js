const Group = require('../models/group')
const welcomeReset = require('../common/welcome-reset')

module.exports = async (ctx, next) => {
  if (ctx.chat.id > 0) {

  } else {
    await Group.findOneAndUpdate({
      group_id: ctx.chat.id
    }, {
      title: ctx.chat.title
    }, { new: true, upsert: true }, function (err, doc) {
      if (err) return console.log(err)
      if (!doc.settings.gifs || !doc.settings.texts) {
        welcomeReset(ctx.chat.id)
      }
      ctx.groupInfo = doc
    })
  }
  return next()
}
