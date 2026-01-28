const mongoose = require('mongoose')

/**
 * CasSyncState - Tracks CAS (Combot Anti-Spam) synchronization state
 *
 * This is a singleton collection - only one document exists at a time.
 * Manages resumable sync with progress tracking and error recovery.
 */
const casSyncStateSchema = mongoose.Schema({
  // Last successful sync completion
  lastSyncAt: { type: Date },

  // For resume capability - tracks where we left off
  lastProcessedUserId: { type: Number, default: 0 },

  // Sync statistics
  stats: {
    totalUsers: { type: Number, default: 0 },
    usersWithMessages: { type: Number, default: 0 },
    messagesProcessed: { type: Number, default: 0 },
    signaturesAdded: { type: Number, default: 0 },
    signaturesUpdated: { type: Number, default: 0 },
    duplicatesSkipped: { type: Number, default: 0 }
  },

  // Current sync status
  status: {
    type: String,
    enum: ['idle', 'running', 'failed', 'stopped'],
    default: 'idle'
  },

  // Last error message if failed
  error: { type: String },

  // Current batch info (for monitoring progress)
  currentBatch: {
    startedAt: { type: Date },
    processedCount: { type: Number, default: 0 },
    totalCount: { type: Number, default: 0 }
  }
}, { timestamps: true })

/**
 * Get or create the singleton sync state document
 */
casSyncStateSchema.statics.getState = async function () {
  let state = await this.findOne()
  if (!state) {
    state = await this.create({})
  }
  return state
}

/**
 * Update status with optional error
 */
casSyncStateSchema.statics.setStatus = async function (status, error = null) {
  const update = { status }
  if (error) update.error = error
  if (status === 'idle') update.error = null

  return this.findOneAndUpdate(
    {},
    { $set: update },
    { upsert: true, new: true }
  )
}

/**
 * Update progress during sync
 */
casSyncStateSchema.statics.updateProgress = async function (lastUserId, stats = {}) {
  const update = {
    lastProcessedUserId: lastUserId,
    'currentBatch.processedCount': stats.processedCount || 0
  }

  // Merge stats if provided
  Object.keys(stats).forEach(key => {
    if (key !== 'processedCount') {
      update[`stats.${key}`] = stats[key]
    }
  })

  return this.findOneAndUpdate(
    {},
    { $set: update },
    { upsert: true, new: true }
  )
}

/**
 * Mark sync as started
 */
casSyncStateSchema.statics.startSync = async function (totalUsers = 0) {
  return this.findOneAndUpdate(
    {},
    {
      $set: {
        status: 'running',
        error: null,
        'currentBatch.startedAt': new Date(),
        'currentBatch.processedCount': 0,
        'currentBatch.totalCount': totalUsers,
        // Reset stats for new sync
        'stats.messagesProcessed': 0,
        'stats.signaturesAdded': 0,
        'stats.signaturesUpdated': 0,
        'stats.duplicatesSkipped': 0
      }
    },
    { upsert: true, new: true }
  )
}

/**
 * Mark sync as completed
 */
casSyncStateSchema.statics.completeSync = async function (stats = {}) {
  return this.findOneAndUpdate(
    {},
    {
      $set: {
        status: 'idle',
        lastSyncAt: new Date(),
        error: null,
        lastProcessedUserId: 0,
        ...Object.keys(stats).reduce((acc, key) => {
          acc[`stats.${key}`] = stats[key]
          return acc
        }, {})
      }
    },
    { upsert: true, new: true }
  )
}

/**
 * Check if sync is currently running
 */
casSyncStateSchema.statics.isRunning = async function () {
  const state = await this.findOne()
  return state?.status === 'running'
}

module.exports = casSyncStateSchema
