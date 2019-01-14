const Group = require('../models/group')

module.exports = async (ctx) => {
  if (ctx.chat.type === 'supergroup' || ctx.chat.type === 'group') {
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
      if (doc.settings === undefined) doc.settings = new Group().settings
      doc.last_act = now
      doc.save()
      ctx.groupInfo = doc
    })
  }
}
