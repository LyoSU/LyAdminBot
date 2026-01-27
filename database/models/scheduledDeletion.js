const mongoose = require('mongoose')

/**
 * ScheduledDeletion - Persistent message deletion queue
 *
 * Stores messages that need to be deleted after a delay.
 * Survives bot restarts - on startup, all expired deletions are processed.
 *
 * Use cases:
 * - Vote result notifications (delete after 2 min)
 * - CAS ban notifications (delete after 25 sec)
 * - High-confidence spam notifications (delete after 30 sec)
 * - "No permissions" warnings (delete after 60 sec)
 * - Vote timeout notifications (delete after 30 sec)
 */
const scheduledDeletionSchema = mongoose.Schema({
  // Target message
  chatId: { type: Number, required: true, index: true },
  messageId: { type: Number, required: true },

  // When to delete
  deleteAt: { type: Date, required: true },  // indexed below (TTL)

  // Source for logging/debugging
  source: {
    type: String,
    enum: [
      // Spam-related
      'vote_result',
      'cas_ban',
      'spam_high_confidence',
      'spam_no_permissions',
      'vote_timeout',
      'report_spam',
      'report_clean',
      // Command responses
      'cmd_ping',
      'cmd_help',
      'cmd_stats',
      'cmd_banan',
      'cmd_welcome',
      // Generic
      'other'
    ],
    default: 'other'
  },

  // Optional reference to related entity (for debugging)
  reference: {
    type: { type: String }, // 'spam_vote', 'user', etc.
    id: String
  },

  // Track creation for debugging
  createdAt: { type: Date, default: Date.now }
})

// Compound index for efficient queries: find all expired + not yet deleted
scheduledDeletionSchema.index({ deleteAt: 1, chatId: 1 })

// TTL index - auto-cleanup old records after 1 hour (in case deletion fails repeatedly)
scheduledDeletionSchema.index({ deleteAt: 1 }, { expireAfterSeconds: 3600 })

/**
 * Static: Find all deletions that should be processed now
 */
scheduledDeletionSchema.statics.findPending = function (limit = 100) {
  return this.find({
    deleteAt: { $lte: new Date() }
  }).limit(limit)
}

/**
 * Static: Schedule a message for deletion
 * @param {Object} options
 * @param {number} options.chatId - Telegram chat ID
 * @param {number} options.messageId - Telegram message ID
 * @param {number} options.delayMs - Delay in milliseconds before deletion
 * @param {string} options.source - Source identifier for logging
 * @param {Object} options.reference - Optional reference to related entity
 */
scheduledDeletionSchema.statics.schedule = async function (options) {
  const { chatId, messageId, delayMs, source = 'other', reference = null } = options

  const deletion = new this({
    chatId,
    messageId,
    deleteAt: new Date(Date.now() + delayMs),
    source,
    reference
  })

  return deletion.save()
}

module.exports = scheduledDeletionSchema
