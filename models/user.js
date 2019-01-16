const mongoose = require('mongoose')


const userSchema = mongoose.Schema({
  telegram_id: {
    type: Number,
    index: true,
    unique: true,
    required: true,
  },
  first_name: String,
  last_name: String,
  username: String,
  first_act: Number,
  last_act: Number,
})

const User = mongoose.model('User', userSchema)

User.prototype.dbUpdate = (ctx) => new Promise((resolve, reject) => {
  User.findOne({ telegram_id: ctx.from.id }, (err, doc) => {
    if (err) {
      reject(err)
    }

    // eslint-disable-next-line no-magic-numbers
    const now = Math.floor(new Date().getTime() / 1000)
    let user = doc

    if (!user) {
      user = new User()

      user.telegram_id = ctx.from.id
      user.first_act = now
    }
    user.first_name = ctx.from.first_name
    user.last_name = ctx.from.last_name
    user.username = ctx.from.username
    user.last_act = now
    user.save()

    resolve(user)
  })
})

module.exports = User
