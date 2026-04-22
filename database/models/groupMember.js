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
    sparse: true
  },
  banan: {
    num: {
      type: Number,
      default: 0
    },
    sum: {
      type: Number,
      default: 0
    },
    stack: {
      type: Number,
      default: 0
    },
    last: {
      who: Number,
      how: Number,
      time: Number
    },
    time: {
      type: Date,
      default: Date.now
    }
  },
  stats: {
    messagesCount: {
      type: Number,
      default: 0
    },
    textTotal: {
      type: Number,
      default: 0
    },
    // First-message latency tracking. joinedAt is set the first time we see
    // this user in this group (either via chat_member event or first message —
    // whichever fires first). firstMessageAt is set on actual posting. Latency
    // is derived (persisted for cheap reads) — very small latency (<30s) is
    // a strong fresh-spam-bot signal, very large (>24h) is a normal lurker.
    joinedAt: { type: Date },
    firstMessageAt: { type: Date },
    firstMessageLatencyMs: { type: Number }
  },
  score: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
})

groupMemberSchema.index({ group: 1, telegram_id: 1 }, { unique: true })

module.exports = groupMemberSchema
