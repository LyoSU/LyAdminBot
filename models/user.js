const mongoose = require('mongoose')

const userSchema = mongoose.Schema({
  telegram_id: { 
    type: Number,
    index: true,
    unique: true
  },
  first_name: String,
  last_name: String,
  username: String,
  first_act: Number,
  last_act: Number
})

const User = mongoose.model('User', userSchema)

module.exports = User
