const mongoose = require('mongoose')

const nameHistoryEntrySchema = new mongoose.Schema({
  value: { type: String },
  seenAt: { type: Date, default: Date.now }
}, { _id: false })

const usernameHistoryEntrySchema = new mongoose.Schema({
  value: { type: String },
  seenAt: { type: Date, default: Date.now }
}, { _id: false })

const externalBanProviderSchema = new mongoose.Schema({
  banned: { type: Boolean, default: false },
  offenses: { type: Number, default: 0 },
  spamFactor: { type: Number, default: 0 },
  scammer: { type: Boolean, default: false },
  when: { type: Date },
  reasons: [{ type: String }],
  checkedAt: { type: Date }
}, { _id: false })

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

  // History of name/username changes — strong signal for fresh-identity spam
  // Entries sorted newest-first, capped at 10 each
  nameHistory: {
    type: [nameHistoryEntrySchema],
    default: []
  },
  usernameHistory: {
    type: [usernameHistoryEntrySchema],
    default: []
  },

  // External ban providers (lols.bot, CAS) — cached snapshot
  externalBan: {
    lols: externalBanProviderSchema,
    cas: externalBanProviderSchema
  },

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
    manualUnbans: { type: Number, default: 0 },
    // Uniqueness tracking — rolling sample of last ~50 normalized message hashes
    // Used to compute uniquenessRatio = distinct / total (strong anti-blast signal)
    uniquenessSamples: [{ type: String }],
    uniqueMessageHashes: { type: Number, default: 0 },
    trackedMessages: { type: Number, default: 0 },
    uniquenessRatio: { type: Number, default: 1 }
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
userSchema.index({ 'externalBan.lols.banned': 1 }, { sparse: true })

module.exports = userSchema
