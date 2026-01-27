const mongoose = require('mongoose')

/**
 * SpamSignature - Community-confirmed spam patterns
 *
 * Flow:
 * 1. New spam detected → hash created → status: 'candidate'
 * 2. Same hash seen in 5+ unique groups → status: 'confirmed'
 * 3. Confirmed match → threshold -= 15 (instant action)
 *
 * TTL: candidates 30d, confirmed 90d (auto-cleanup)
 */
const spamSignatureSchema = mongoose.Schema({
  // Multi-layer hashing for different match types
  exactHash: { type: String, index: true, sparse: true },       // Exact text match
  normalizedHash: { type: String, index: true, sparse: true },  // Template match (vars removed)
  fuzzyHash: { type: String, index: true, sparse: true },       // SimHash for similarity
  structureHash: { type: String, index: true, sparse: true },   // Message structure pattern

  // Confirmation status
  status: {
    type: String,
    enum: ['candidate', 'confirmed'],
    default: 'candidate'
  },

  // Community confirmation
  confirmations: { type: Number, default: 1 },
  uniqueGroups: [{ type: Number }], // Group IDs where this was seen

  // Sample for debugging/review
  sampleText: { type: String, maxLength: 200 },

  // Timestamps
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },

  // TTL field - MongoDB will auto-delete expired documents
  expiresAt: {
    type: Date,
    default: function () {
      // Candidates expire in 30 days, confirmed in 90 days
      const days = this.status === 'confirmed' ? 90 : 30
      return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    },
    index: { expires: 0 }
  }
}, { timestamps: true })

// Update TTL when status changes to confirmed
spamSignatureSchema.pre('save', function (next) {
  if (this.isModified('status') && this.status === 'confirmed') {
    this.expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
  }
  next()
})

// Unique index on exactHash to prevent duplicates
spamSignatureSchema.index({ exactHash: 1 }, { unique: true, sparse: true })

// Compound indexes for efficient lookups
spamSignatureSchema.index({ exactHash: 1, status: 1 })
spamSignatureSchema.index({ normalizedHash: 1, status: 1 })
spamSignatureSchema.index({ fuzzyHash: 1, status: 1 })
spamSignatureSchema.index({ structureHash: 1, status: 1, confirmations: 1 })

module.exports = spamSignatureSchema
