const mongoose = require('mongoose')

/**
 * ForwardBlacklist - Track suspicious forward sources
 *
 * Unlike in-memory velocity tracking, this persists across restarts
 * and builds long-term reputation for forward sources.
 *
 * Flow:
 * 1. Spam confirmed via votes → forward source spamReports++
 * 2. Reaches threshold → status changes (clean → suspicious → blacklisted)
 * 3. Blacklisted sources get instant high-risk flag
 *
 * Thresholds by type (hidden sources are more suspicious):
 *   hidden:  { suspicious: 3, blacklisted: 6 }
 *   channel: { suspicious: 5, blacklisted: 10 }
 *   chat:    { suspicious: 5, blacklisted: 10 }
 *   user:    { suspicious: 8, blacklisted: 15 }
 */

const THRESHOLDS = {
  hidden: { suspicious: 3, blacklisted: 6 },
  channel: { suspicious: 5, blacklisted: 10 },
  chat: { suspicious: 5, blacklisted: 10 },
  user: { suspicious: 8, blacklisted: 15 }
}

const forwardBlacklistSchema = mongoose.Schema({
  // Hash of forward source (from getForwardHash in velocity.js)
  forwardHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Type of forward source
  forwardType: {
    type: String,
    enum: ['user', 'hidden', 'chat', 'channel'],
    required: true,
    index: true
  },

  // Current status
  status: {
    type: String,
    enum: ['clean', 'suspicious', 'blacklisted'],
    default: 'clean',
    index: true
  },

  // Spam reports count (from confirmed votes)
  spamReports: { type: Number, default: 0 },

  // Clean reports count (from votes that resulted in unban)
  cleanReports: { type: Number, default: 0 },

  // Unique groups where this source was reported
  uniqueGroups: [{ type: Number }],

  // For debugging/review
  sourceIdentifier: String, // Original ID or name
  sampleText: { type: String, maxLength: 200 },

  // Timestamps
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },

  // TTL - auto-cleanup old entries
  // Clean sources expire faster, blacklisted stay longer
  expiresAt: {
    type: Date,
    default: function () {
      const days = this.status === 'blacklisted' ? 180 : // 6 months
        this.status === 'suspicious' ? 90 : // 3 months
          30 // 1 month for clean
      return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    },
    index: { expires: 0 }
  }
}, { timestamps: true })

/**
 * Report spam from this forward source
 * Automatically updates status based on thresholds
 */
forwardBlacklistSchema.methods.reportSpam = function (groupId, sampleText = null) {
  this.spamReports++
  this.lastSeenAt = new Date()

  if (groupId && !this.uniqueGroups.includes(groupId)) {
    this.uniqueGroups.push(groupId)
  }

  if (sampleText && !this.sampleText) {
    this.sampleText = sampleText.substring(0, 200)
  }

  // Update status based on thresholds
  const thresholds = THRESHOLDS[this.forwardType] || THRESHOLDS.user
  if (this.spamReports >= thresholds.blacklisted) {
    this.status = 'blacklisted'
    this.expiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000)
  } else if (this.spamReports >= thresholds.suspicious) {
    this.status = 'suspicious'
    this.expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
  }

  return this
}

/**
 * Report clean verdict (false positive)
 * Reduces spam reports, can demote status
 */
forwardBlacklistSchema.methods.reportClean = function () {
  this.cleanReports++

  // Reduce effective spam count
  // Clean reports counteract spam reports (2:1 ratio)
  const effectiveSpam = Math.max(0, this.spamReports - Math.floor(this.cleanReports / 2))

  const thresholds = THRESHOLDS[this.forwardType] || THRESHOLDS.user
  if (effectiveSpam < thresholds.suspicious) {
    this.status = 'clean'
    this.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  } else if (effectiveSpam < thresholds.blacklisted) {
    this.status = 'suspicious'
    this.expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
  }

  return this
}

/**
 * Static method to check and get forward source
 */
forwardBlacklistSchema.statics.checkSource = async function (forwardHash) {
  return this.findOne({ forwardHash })
}

/**
 * Static method to report spam with upsert (atomic operation)
 */
forwardBlacklistSchema.statics.addSpamReport = async function (forwardInfo, groupId, sampleText = null) {
  if (!forwardInfo || !forwardInfo.hash || !forwardInfo.type) {
    return null
  }

  const thresholds = THRESHOLDS[forwardInfo.type] || THRESHOLDS.user

  // Atomic upsert - increment spamReports and add to uniqueGroups
  const updateOps = {
    $inc: { spamReports: 1 },
    $set: {
      lastSeenAt: new Date(),
      forwardType: forwardInfo.type
    },
    $setOnInsert: {
      forwardHash: forwardInfo.hash,
      sourceIdentifier: forwardInfo.identifier || forwardInfo.hash.substring(0, 16),
      firstSeenAt: new Date(),
      status: 'clean'
    }
  }

  if (groupId) {
    updateOps.$addToSet = { uniqueGroups: groupId }
  }

  if (sampleText) {
    updateOps.$set.sampleText = sampleText.substring(0, 200)
  }

  const entry = await this.findOneAndUpdate(
    { forwardHash: forwardInfo.hash },
    updateOps,
    { upsert: true, new: true }
  )

  // Update status based on new spamReports count
  // Check blacklisted first (higher priority), then suspicious
  let statusChanged = false
  if (entry.spamReports >= thresholds.blacklisted && entry.status !== 'blacklisted') {
    entry.status = 'blacklisted'
    entry.expiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000)
    statusChanged = true
  } else if (entry.spamReports >= thresholds.suspicious && entry.status !== 'suspicious' && entry.status !== 'blacklisted') {
    // Only upgrade to suspicious if currently clean (not already suspicious or blacklisted)
    entry.status = 'suspicious'
    entry.expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    statusChanged = true
  }

  if (statusChanged) {
    await entry.save()
  }

  return entry
}

/**
 * Static method to report clean verdict (atomic operation)
 */
forwardBlacklistSchema.statics.addCleanReport = async function (forwardHash) {
  // Atomic increment of cleanReports
  const entry = await this.findOneAndUpdate(
    { forwardHash },
    { $inc: { cleanReports: 1 } },
    { new: true }
  )

  if (!entry) return null

  // Recalculate status based on effective spam count
  // Clean reports counteract spam reports (2:1 ratio)
  const effectiveSpam = Math.max(0, entry.spamReports - Math.floor(entry.cleanReports / 2))
  const thresholds = THRESHOLDS[entry.forwardType] || THRESHOLDS.user

  let statusChanged = false
  if (effectiveSpam < thresholds.suspicious && entry.status !== 'clean') {
    entry.status = 'clean'
    entry.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    statusChanged = true
  } else if (effectiveSpam < thresholds.blacklisted && entry.status === 'blacklisted') {
    entry.status = 'suspicious'
    entry.expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    statusChanged = true
  }

  if (statusChanged) {
    await entry.save()
  }

  return entry
}

// Export thresholds for use in other modules
forwardBlacklistSchema.statics.THRESHOLDS = THRESHOLDS

module.exports = forwardBlacklistSchema
