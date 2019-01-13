const User = require('../models/user')

module.exports = async (ctx, next) => {
  await User.findOneAndUpdate({
    telegram_id: ctx.from.id
  }, {
    first_name: ctx.from.first_name,
    last_name: ctx.from.last_name,
    username: ctx.from.username,
    last_act: ctx.message.date
  }, { new: true, setDefaultsOnInsert: true, upsert: true }, function (err, doc) {
    if (err) return console.log(err)
  })
  ctx.mixpanel.people.set()
  ctx.mixpanel.people.setOnce({
    $created: new Date().toISOString()
  })
  return next()
}