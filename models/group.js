const mongoose = require('mongoose')

const groupSchema = mongoose.Schema({
  group_id: { type: Number, index: true, unique: true },
  title: String,
  settings: {
    welcome: Boolean,
    gifs: Object,
    captions: Object
  }
})

const Group = mongoose.model('Group', groupSchema)

module.exports = Group
