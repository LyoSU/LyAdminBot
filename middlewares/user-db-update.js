const User = require('../models/user')

module.exports = async (ctx, next) => {
  if (ctx.chat.type !== 'channel') {
    await User.findOne({
      telegram_id: ctx.from.id
    }, function (err, doc) {
      if (err) return console.log(err)
      const now = Math.floor(new Date().getTime() / 1000)
      if (!doc) {
        var doc = new User()
        doc.telegram_id = ctx.from.id
        doc.first_act = now
      }
      doc.first_name = ctx.from.first_name
      doc.last_name = ctx.from.last_name
      doc.username = ctx.from.username
      doc.last_act = now
      doc.save()
    })
    ctx.mixpanel.people.set()
    ctx.mixpanel.people.setOnce({
      $created: new Date().toISOString()
    })
  }
  return next()
}
