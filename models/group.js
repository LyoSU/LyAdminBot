const mongoose = require('mongoose')

const groupSchema = mongoose.Schema({
  group_id: { type: Number, index: true, unique: true },
  settings: Object
})

const Group = mongoose.model('Group', groupSchema)

module.exports = Group
