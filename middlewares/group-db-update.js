const Group = require('../models/group')

module.exports = (ctx, next) => {
  if (ctx.chat.type === 'supergroup' || ctx.chat.type === 'group') {
    Group.findOne({
      group_id: ctx.chat.id
    }, (err, doc) => {
      if (err) return console.log(err)
      const now = Math.floor(new Date().getTime() / 1000)
      if (!doc) {
        var doc = new Group()
        doc.group_id = ctx.chat.id
        doc.first_act = now
      }
      if (doc.settings === undefined) doc.settings = new Group().settings
      doc.title = ctx.chat.title
      doc.last_act = now
      doc.save()
      ctx.groupInfo = doc
    })
  }
  return next()
}
