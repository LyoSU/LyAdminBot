const mongoose = require('mongoose')

const groupMemberSchema = mongoose.Schema({
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group'
  },
  telegram_id: {
    type: Number,
    index: true,
    required: true,
    sparse: true,
  },
  banan: {
    num: {
      type: Number,
      default: 0,
    },
    sum: {
      type: Number,
      default: 0,
    },
    stack: {
      type: Number,
      default: 0,
    },
    last: {
      who: Number,
      how: Number,
      time: Number,
    },
    time: {
      type: Date,
      default: Date.now,
    },
  },
  stats: {
    messagesCount: {
      type: Number,
      default: 0,
    },
    messageType: Object,
    textTotal: {
      type: Number,
      default: 0,
    },
  },
  score: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
})

module.exports = groupMemberSchema
