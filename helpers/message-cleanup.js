/**
 * Message Cleanup Service
 *
 * Centralized, persistent message deletion system.
 * All scheduled deletions are stored in MongoDB and survive bot restarts.
 *
 * Architecture:
 * 1. Messages scheduled via scheduleDeletion() are stored in DB
 * 2. processCleanupQueue() runs periodically and on startup
 * 3. Each deletion is attempted, then removed from queue on success
 * 4. Failed deletions remain in queue for retry (up to TTL limit)
 */

const { cleanup: log } = require('./logger')

// In-memory timers for recent deletions (optimization: avoid DB polling for short delays)
const pendingTimers = new Map()

// Cleanup interval handle
let cleanupIntervalId = null

/**
 * Schedule a message for deletion
 *
 * @param {Object} db - Database instance with ScheduledDeletion model
 * @param {Object} options
 * @param {number} options.chatId - Telegram chat ID
 * @param {number} options.messageId - Telegram message ID
 * @param {number} options.delayMs - Delay in milliseconds before deletion
 * @param {string} options.source - Source identifier ('vote_result', 'cas_ban', etc.)
 * @param {Object} options.reference - Optional reference { type, id }
 * @param {Object} telegram - Telegram API instance (for immediate short delays)
 */
const scheduleDeletion = async (db, options, telegram = null) => {
  const { chatId, messageId, delayMs, source = 'other', reference = null } = options

  if (!chatId || !messageId || !delayMs) {
    log.warn({ chatId, messageId, delayMs }, 'Invalid deletion params')
    return null
  }

  // For very short delays (< 15 seconds), use in-memory timer + DB backup
  // This provides instant response while maintaining persistence
  if (delayMs < 15000 && telegram) {
    const timerId = setTimeout(async () => {
      pendingTimers.delete(`${chatId}:${messageId}`)
      try {
        await telegram.deleteMessage(chatId, messageId)
        log.debug({ chatId, messageId, source }, 'Deleted (in-memory timer)')
        // Remove from DB if it was saved
        await db.ScheduledDeletion.deleteOne({ chatId, messageId }).catch(() => {})
      } catch (error) {
        if (!error.message.includes('message to delete not found')) {
          log.debug({ chatId, messageId, err: error.message }, 'Delete failed (in-memory)')
        }
      }
    }, delayMs)

    pendingTimers.set(`${chatId}:${messageId}`, timerId)
  }

  // Always persist to DB for crash recovery
  try {
    const deletion = await db.ScheduledDeletion.schedule({
      chatId,
      messageId,
      delayMs,
      source,
      reference
    })

    log.debug({
      chatId,
      messageId,
      source,
      deleteAt: deletion.deleteAt
    }, 'Scheduled deletion')

    return deletion
  } catch (error) {
    log.error({ err: error.message, chatId, messageId }, 'Failed to schedule deletion')
    return null
  }
}

/**
 * Cancel a scheduled deletion
 *
 * @param {Object} db - Database instance
 * @param {number} chatId - Telegram chat ID
 * @param {number} messageId - Telegram message ID
 */
const cancelDeletion = async (db, chatId, messageId) => {
  // Cancel in-memory timer if exists
  const timerKey = `${chatId}:${messageId}`
  if (pendingTimers.has(timerKey)) {
    clearTimeout(pendingTimers.get(timerKey))
    pendingTimers.delete(timerKey)
  }

  // Remove from DB
  try {
    const result = await db.ScheduledDeletion.deleteOne({ chatId, messageId })
    if (result.deletedCount > 0) {
      log.debug({ chatId, messageId }, 'Cancelled deletion')
    }
    return result.deletedCount > 0
  } catch (error) {
    log.error({ err: error.message, chatId, messageId }, 'Failed to cancel deletion')
    return false
  }
}

/**
 * Process all pending deletions in the queue
 * Called periodically and on bot startup
 *
 * @param {Object} db - Database instance
 * @param {Object} telegram - Telegram API instance
 * @returns {Object} { processed: number, deleted: number, failed: number }
 */
const processCleanupQueue = async (db, telegram) => {
  const stats = { processed: 0, deleted: 0, failed: 0 }

  try {
    const pendingDeletions = await db.ScheduledDeletion.findPending(100)

    if (pendingDeletions.length === 0) {
      return stats
    }

    log.debug({ count: pendingDeletions.length }, 'Processing cleanup queue')

    for (const deletion of pendingDeletions) {
      stats.processed++

      try {
        await telegram.deleteMessage(deletion.chatId, deletion.messageId)
        stats.deleted++

        log.debug({
          chatId: deletion.chatId,
          messageId: deletion.messageId,
          source: deletion.source
        }, 'Deleted message')
      } catch (error) {
        // "message to delete not found" is expected (already deleted or too old)
        // "message can't be deleted" means no permissions - also treat as resolved
        const isExpected = error.message.includes('message to delete not found') ||
                          error.message.includes("message can't be deleted") ||
                          error.message.includes('bot is not a member')

        if (!isExpected) {
          stats.failed++
          log.warn({
            chatId: deletion.chatId,
            messageId: deletion.messageId,
            err: error.message
          }, 'Delete failed')
        }
      }

      // Remove from queue regardless of success/failure
      // (TTL index will cleanup stuck records anyway)
      try {
        await db.ScheduledDeletion.deleteOne({ _id: deletion._id })
      } catch (dbError) {
        log.error({ err: dbError.message, id: deletion._id }, 'Failed to remove from queue')
      }
    }

    if (stats.processed > 0) {
      log.info({
        processed: stats.processed,
        deleted: stats.deleted,
        failed: stats.failed
      }, 'Cleanup queue processed')
    }
  } catch (error) {
    log.error({ err: error.message }, 'Error processing cleanup queue')
  }

  return stats
}

/**
 * Process pending deletions on bot startup
 * Handles all messages that should have been deleted while bot was down
 *
 * @param {Object} db - Database instance
 * @param {Object} telegram - Telegram API instance
 */
const processStartupCleanup = async (db, telegram) => {
  log.info('Processing startup cleanup...')

  const stats = await processCleanupQueue(db, telegram)

  if (stats.processed > 0) {
    log.info({
      recovered: stats.deleted,
      failed: stats.failed
    }, 'Startup cleanup complete')
  } else {
    log.debug('No pending deletions on startup')
  }

  return stats
}

/**
 * Start the periodic cleanup interval
 *
 * @param {Object} db - Database instance
 * @param {Object} telegram - Telegram API instance
 * @param {number} intervalMs - Interval in milliseconds (default: 30 seconds)
 */
const startCleanupInterval = (db, telegram, intervalMs = 30000) => {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId)
  }

  cleanupIntervalId = setInterval(() => {
    processCleanupQueue(db, telegram)
  }, intervalMs)

  log.debug({ intervalMs }, 'Started cleanup interval')

  return cleanupIntervalId
}

/**
 * Stop the cleanup interval
 */
const stopCleanupInterval = () => {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId)
    cleanupIntervalId = null
    log.debug('Stopped cleanup interval')
  }
}

/**
 * Get queue statistics
 *
 * @param {Object} db - Database instance
 */
const getQueueStats = async (db) => {
  try {
    const total = await db.ScheduledDeletion.countDocuments()
    const pending = await db.ScheduledDeletion.countDocuments({
      deleteAt: { $lte: new Date() }
    })
    const upcoming = total - pending

    return { total, pending, upcoming, inMemoryTimers: pendingTimers.size }
  } catch (error) {
    log.error({ err: error.message }, 'Failed to get queue stats')
    return null
  }
}

module.exports = {
  scheduleDeletion,
  cancelDeletion,
  processCleanupQueue,
  processStartupCleanup,
  startCleanupInterval,
  stopCleanupInterval,
  getQueueStats
}
