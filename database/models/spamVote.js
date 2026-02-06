const mongoose = require('mongoose')
const crypto = require('crypto')

/**
 * SpamVote - Community voting on AI bans
 *
 * Flow:
 * 1. AI detects spam → create vote event → show voting UI
 * 2. Trusted users/admins vote (spam/clean)
 * 3. When total weighted votes >= 3:
 *    - cleanWeighted > spamWeighted → unban + set trusted
 *    - spamWeighted >= cleanWeighted → confirm spam + add to signatures
 * 4. Timeout (5 min) → process with current votes (or default to spam if none)
 *
 * Vote weights:
 * - Admin: ×3
 * - Trusted user: ×1
 * - Regular users: cannot vote
 */
const spamVoteSchema = mongoose.Schema({
  // Unique event identifier (12 char hex for compact callback data)
  eventId: {
    type: String,
    unique: true,
    index: true,
    default: () => crypto.randomBytes(6).toString('hex')
  },

  // Group context
  chatId: { type: Number, required: true, index: true },

  // Banned user info
  bannedUserId: { type: Number, required: true, index: true },
  bannedUserName: String,
  bannedUserUsername: String,

  // User context at time of ban (for UI display)
  userContext: {
    reputationScore: Number,
    reputationStatus: String,
    accountAgeDays: Number,
    messagesInGroup: Number,
    groupsActive: Number,
    signals: [String] // quick assessment signals
  },

  // Spam detection info
  messageHash: String,
  messagePreview: { type: String, maxLength: 200 },
  aiConfidence: Number,
  aiReason: String,

  // Forward origin info (for ForwardBlacklist tracking)
  forwardOrigin: {
    type: { type: String, enum: ['user', 'hidden', 'chat', 'channel'] },
    hash: String,
    identifier: String
  },

  // Actions taken
  actionTaken: {
    muted: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    banned: { type: Boolean, default: false }, // Full ban with revoke_messages
    muteDuration: Number // seconds
  },

  // Notification message (for UI updates)
  notificationMessageId: Number,
  notificationChatId: Number, // Usually same as chatId, but explicit

  // Voters list with full details
  voters: [{
    userId: { type: Number, required: true },
    username: String,
    displayName: String,
    vote: {
      type: String,
      enum: ['spam', 'clean'],
      required: true
    },
    weight: { type: Number, default: 1 },
    isAdmin: { type: Boolean, default: false },
    votedAt: { type: Date, default: Date.now }
  }],

  // Vote tallies (pre-computed for quick access)
  voteTally: {
    spamCount: { type: Number, default: 0 },
    cleanCount: { type: Number, default: 0 },
    spamWeighted: { type: Number, default: 0 },
    cleanWeighted: { type: Number, default: 0 }
  },

  // Final result
  result: {
    type: String,
    enum: ['pending', 'spam', 'clean'],
    default: 'pending'
  },
  resolvedAt: Date,
  resolvedBy: String, // 'votes', 'timeout', 'admin_override'

  // Expiration for voting window (5 minutes default)
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 5 * 60 * 1000),
    index: true
  }
}, { timestamps: true })

// TTL index - auto-delete after 24h
spamVoteSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 })

// Compound indexes for queries
spamVoteSchema.index({ chatId: 1, result: 1 })
spamVoteSchema.index({ bannedUserId: 1, result: 1 })
spamVoteSchema.index({ result: 1, expiresAt: 1 })

/**
 * Check if a user has already voted
 */
spamVoteSchema.methods.hasVoted = function (userId) {
  return this.voters.some(v => v.userId === userId)
}

/**
 * Add a vote and update tallies
 */
spamVoteSchema.methods.addVote = function (voter) {
  if (this.hasVoted(voter.userId)) {
    return false
  }

  this.voters.push({
    userId: voter.userId,
    username: voter.username,
    displayName: voter.displayName,
    vote: voter.vote,
    weight: voter.weight,
    isAdmin: voter.isAdmin,
    votedAt: new Date()
  })

  // Update tallies
  if (voter.vote === 'spam') {
    this.voteTally.spamCount++
    this.voteTally.spamWeighted += voter.weight
  } else {
    this.voteTally.cleanCount++
    this.voteTally.cleanWeighted += voter.weight
  }

  return true
}

/**
 * Check if enough votes to decide
 */
spamVoteSchema.methods.canResolve = function () {
  const totalWeighted = this.voteTally.spamWeighted + this.voteTally.cleanWeighted
  return totalWeighted >= 3
}

/**
 * Determine the winning vote
 * cleanWeighted > spamWeighted → clean (benefit of doubt)
 */
spamVoteSchema.methods.getWinner = function () {
  if (this.voteTally.cleanWeighted > this.voteTally.spamWeighted) {
    return 'clean'
  }
  return 'spam'
}

/**
 * Static: Find pending votes that have expired
 */
spamVoteSchema.statics.findExpired = function (limit = 50) {
  return this.find({
    result: 'pending',
    expiresAt: { $lte: new Date() }
  }).limit(limit)
}

module.exports = spamVoteSchema
