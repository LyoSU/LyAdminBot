const Group = require('../models/group')

module.exports = async (ctx, next) => {
  if (ctx.chat.id > 0) {

  } else {
    await Group.findOne({
      group_id: ctx.chat.id
    }, { new: true, upsert: true }, async (err, doc) => {
      if (err) return console.log(err)
      if (!doc) {
        var doc = new Group()
        doc.group_id = ctx.chat.id
        doc.first_act = ctx.message.date
      }
      doc.title = ctx.chat.title
      doc.last_act = ctx.message.date
      doc.save()
      ctx.groupInfo = doc
    })
  }
  return next()
}
