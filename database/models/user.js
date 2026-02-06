const mongoose = require('mongoose')

const userSchema = mongoose.Schema({
  telegram_id: {
    type: Number,
    index: true,
    unique: true,
    required: true
  },
  first_name: String,
  last_name: String,
  username: String,
  locale: String,
  isGlobalBanned: {
    type: Boolean,
    default: false
  },
  globalBanReason: String,
  globalBanDate: Date,

  // Global statistics (aggregated across all groups)
  globalStats: {
    totalMessages: { type: Number, default: 0 },
    groupsActive: { type: Number, default: 0 },
    groupsList: [{ type: Number }],
    firstSeen: { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now },
    // Negative signals
    spamDetections: { type: Number, default: 0 },
    deletedMessages: { type: Number, default: 0 },
    // Positive signals
    cleanMessages: { type: Number, default: 0 },
    manualUnbans: { type: Number, default: 0 }
  },

  // Computed reputation
  reputation: {
    score: { type: Number, default: 50 },
    status: {
      type: String,
      enum: ['trusted', 'neutral', 'suspicious', 'restricted'],
      default: 'neutral'
    },
    lastCalculated: { type: Date, default: Date.now }
  }
}, {
  timestamps: true
})

userSchema.index({ isGlobalBanned: 1 }, { sparse: true })
userSchema.index({ 'reputation.status': 1 }, { sparse: true })

module.exports = userSchema
