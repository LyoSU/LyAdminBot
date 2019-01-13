const User = require('../models/user')

module.exports = async (ctx, next) => {
  await User.findOne({
    telegram_id: ctx.from.id
  }, { new: true, setDefaultsOnInsert: true, upsert: true }, function (err, doc) {
    if (err) return console.log(err)
    if (!doc) {
      var doc = new User()
      doc.telegram_id = ctx.from.id
      doc.first_act = ctx.message.date
    }
    doc.first_name = ctx.from.first_name
    doc.last_name = ctx.from.last_name
    doc.username = ctx.from.username
    doc.last_act = ctx.message.date
    doc.save()
  })
  ctx.mixpanel.people.set()
  ctx.mixpanel.people.setOnce({
    $created: new Date().toISOString()
  })
  return next()
}
