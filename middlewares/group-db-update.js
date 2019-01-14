const Group = require('../models/group')

module.exports = async (ctx, next) => {
  if (ctx.chat.id > 0) {

  } else {
    await Group.findOne({
      group_id: ctx.chat.id
    }, async (err, doc) => {
      if (err) return console.log(err)
      const now = Math.floor(new Date().getTime() / 1000)
      if (!doc) {
        var doc = new Group()
        doc.group_id = ctx.chat.id
        doc.first_act = now
      } 

      doc.title = ctx.chat.title
      doc.last_act = now
      doc.save()
      ctx.groupInfo = doc

      console.log(doc)
    })
  }
  return next()
}