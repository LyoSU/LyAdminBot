const mongoose = require('mongoose')

const spamPatternSchema = mongoose.Schema({
  contentHash: {
    type: String,
    index: true,
    unique: true,
    required: true
  },
  embedding: {
    type: [Number],
    required: true
  },
  classification: {
    type: String,
    enum: ['spam', 'clean'],
    required: true,
    index: true
  },
  confidence: {
    type: Number,
    min: 0,
    max: 1,
    required: true
  },
  features: {
    messageLength: Number,
    wordCount: Number,
    hasLinks: Boolean,
    hasEmojis: Boolean,
    hasMentions: Boolean,
    hasPhoneNumbers: Boolean,
    hasEmails: Boolean,
    capitalRatio: Number,
    digitRatio: Number,
    specialCharRatio: Number,
    isNewUser: Boolean,
    isPremium: Boolean,
    userMessageCount: Number
  },
  hitCount: {
    type: Number,
    default: 1
  },
  lastMatched: {
    type: Date,
    default: Date.now,
    index: true
  },
  source: {
    type: String,
    enum: ['llm_analysis', 'cluster_merge'],
    default: 'llm_analysis'
  }
}, {
  timestamps: true
})

// TTL index - automatically delete after 6 months
spamPatternSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 })

// Compound indexes for performance
spamPatternSchema.index({ classification: 1, confidence: -1 })
spamPatternSchema.index({ hitCount: -1, lastMatched: -1 })

module.exports = spamPatternSchema
