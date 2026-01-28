const got = require('got')
const { casSync: log } = require('./logger')
const { generateSignatures } = require('./spam-signatures')

/**
 * CAS (Combot Anti-Spam) Synchronization System
 *
 * Imports spam patterns from CAS database into local SpamSignature collection.
 * Features:
 * - Bulk import from CAS export
 * - Resumable sync (tracks lastProcessedUserId)
 * - Rate limiting and batching
 * - Deduplication via existing spam-signatures system
 */

// Configuration with defaults and validation
const CONFIG = {
  enabled: process.env.CAS_SYNC_ENABLED === 'true',
  intervalHours: Math.max(1, parseInt(process.env.CAS_SYNC_INTERVAL_HOURS, 10) || 6),
  batchSize: Math.max(10, parseInt(process.env.CAS_SYNC_BATCH_SIZE, 10) || 1000),
  concurrency: Math.max(1, parseInt(process.env.CAS_SYNC_CONCURRENCY, 10) || 10),
  maxUsers: Math.max(100, parseInt(process.env.CAS_SYNC_MAX_USERS, 10) || 50000),
  requestDelay: Math.max(0, parseInt(process.env.CAS_SYNC_REQUEST_DELAY, 10) || 100)
}

// Base URL for CAS API
const CAS_API_BASE = 'https://api.cas.chat'

// HTTP client with reasonable timeouts (got v9 compatible)
const casApi = got.extend({
  timeout: 5000, // 5s for individual requests
  retries: 2,
  throwHttpErrors: false
})

// Graceful stop flag
let stopRequested = false

/**
 * Fetch CAS export CSV and parse user IDs
 * @returns {Promise<number[]>} Array of user IDs
 */
async function fetchCasExport () {
  log.info('Fetching CAS export...')

  try {
    const response = await casApi.get(`${CAS_API_BASE}/export.csv`, {
      timeout: 60000 // 1 minute for large file
    })

    if (response.statusCode !== 200) {
      throw new Error(`CAS export returned status ${response.statusCode}`)
    }

    // Parse CSV - format is simple: one user ID per line
    const lines = response.body.trim().split('\n')
    const userIds = lines
      .map(line => parseInt(line.trim(), 10))
      .filter(id => !isNaN(id) && id > 0)

    log.info({ totalUsers: userIds.length }, 'Parsed CAS export')
    return userIds
  } catch (error) {
    log.error({ err: error.message }, 'Failed to fetch CAS export')
    throw error
  }
}

/**
 * Fetch user info and messages from CAS API
 * @param {number} userId
 * @returns {Promise<{ok: boolean, messages: string[]}>}
 */
async function fetchUserMessages (userId) {
  try {
    const response = await casApi.get(`${CAS_API_BASE}/check?user_id=${userId}`, {
      json: true
    })

    if (response.statusCode !== 200) {
      return { ok: false, messages: [] }
    }

    const body = response.body
    if (!body.ok || !body.result) {
      return { ok: false, messages: [] }
    }

    return {
      ok: true,
      messages: body.result.messages || [],
      offenses: body.result.offenses || 0,
      reasons: body.result.reasons || []
    }
  } catch (error) {
    // Log network errors at warn level, others at debug
    const isNetworkError = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(error.code)
    if (isNetworkError) {
      log.warn({ userId, err: error.message, code: error.code }, 'Network error fetching user')
    } else {
      log.debug({ userId, err: error.message }, 'Failed to fetch user')
    }
    return { ok: false, messages: [] }
  }
}

/**
 * Add a CAS message to signatures collection
 * CAS messages are auto-confirmed with synthetic chatId
 * @param {string} text
 * @param {Object} db
 * @returns {Promise<{isNew: boolean}|null>}
 */
async function addCasMessage (text, db) {
  if (!text || text.length < 20) return null

  // Use special chatId for CAS imports (-1 reserved for CAS)
  const CAS_CHAT_ID = -1

  const signatures = generateSignatures(text)
  if (!signatures) return null

  try {
    // Upsert with CAS-specific handling
    const result = await db.SpamSignature.findOneAndUpdate(
      { normalizedHash: signatures.normalizedHash },
      {
        $inc: { confirmations: 1 },
        $addToSet: { uniqueGroups: CAS_CHAT_ID },
        $set: {
          lastSeenAt: new Date(),
          fuzzyHash: signatures.fuzzyHash,
          structureHash: signatures.structureHash,
          status: 'confirmed'
        },
        $setOnInsert: {
          exactHash: signatures.exactHash,
          sampleText: text.substring(0, 200),
          firstSeenAt: new Date(),
          source: 'cas_import'
        }
      },
      { upsert: true, new: true }
    )

    // Return whether it was newly created
    return { isNew: result.confirmations === 1 }
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key - update existing
      await db.SpamSignature.updateOne(
        { normalizedHash: signatures.normalizedHash },
        {
          $inc: { confirmations: 1 },
          $set: { lastSeenAt: new Date(), status: 'confirmed' }
        }
      )
      return { isNew: false }
    }
    throw err
  }
}

/**
 * Process a single user and return stats
 * @param {number} userId
 * @param {Object} db
 * @returns {Promise<{usersWithMessages: number, messagesProcessed: number, signaturesAdded: number, signaturesUpdated: number}>}
 */
async function processUser (userId, db) {
  const result = {
    usersWithMessages: 0,
    messagesProcessed: 0,
    signaturesAdded: 0,
    signaturesUpdated: 0
  }

  if (stopRequested) return result

  const userData = await fetchUserMessages(userId)

  if (userData.ok && userData.messages.length > 0) {
    result.usersWithMessages = 1

    for (const message of userData.messages.slice(0, 10)) {
      if (stopRequested) break

      try {
        const addResult = await addCasMessage(message, db)
        if (addResult) {
          result.messagesProcessed++
          if (addResult.isNew) {
            result.signaturesAdded++
          } else {
            result.signaturesUpdated++
          }
        }
      } catch (err) {
        log.debug({ err: err.message }, 'Failed to add message')
      }
    }
  }

  await delay(CONFIG.requestDelay)
  return result
}

/**
 * Process a batch of user IDs concurrently
 * Returns aggregated stats (no shared mutation)
 * @param {number[]} userIds
 * @param {Object} db
 * @returns {Promise<Object>} Aggregated stats
 */
async function processBatch (userIds, db) {
  const results = await Promise.all(
    userIds.map(userId => processUser(userId, db))
  )

  // Aggregate results safely (no race conditions)
  return results.reduce((acc, r) => ({
    usersWithMessages: acc.usersWithMessages + r.usersWithMessages,
    messagesProcessed: acc.messagesProcessed + r.messagesProcessed,
    signaturesAdded: acc.signaturesAdded + r.signaturesAdded,
    signaturesUpdated: acc.signaturesUpdated + r.signaturesUpdated
  }), {
    usersWithMessages: 0,
    messagesProcessed: 0,
    signaturesAdded: 0,
    signaturesUpdated: 0
  })
}

/**
 * Run the full CAS synchronization
 * @param {Object} db
 * @param {Object} options
 * @returns {Promise<{status: string, stats?: Object, error?: string}>}
 */
async function runSync (db, options = {}) {
  const {
    resume = true,
    maxUsers = CONFIG.maxUsers
  } = options

  // Check if already running
  const isRunning = await db.CasSyncState.isRunning()
  if (isRunning) {
    log.warn('Sync already running, skipping')
    return { status: 'skipped', reason: 'already_running' }
  }

  stopRequested = false

  try {
    // Fetch user IDs
    const allUserIds = await fetchCasExport()

    // Get resume point if enabled
    let startIndex = 0
    if (resume) {
      const state = await db.CasSyncState.getState()
      if (state.lastProcessedUserId > 0) {
        const resumeIndex = allUserIds.indexOf(state.lastProcessedUserId)
        if (resumeIndex === -1) {
          // Resume point not found in current export
          log.warn(
            { lastProcessedUserId: state.lastProcessedUserId },
            'Resume point not found in CAS export, starting from beginning'
          )
        } else if (resumeIndex > 0) {
          startIndex = resumeIndex + 1
          log.info({ resumeFrom: state.lastProcessedUserId, index: startIndex }, 'Resuming sync')
        }
      }
    }

    // Limit to maxUsers
    const userIds = allUserIds.slice(startIndex, startIndex + maxUsers)

    if (userIds.length === 0) {
      log.info('No users to process')
      await db.CasSyncState.completeSync({ totalUsers: allUserIds.length })
      return { status: 'completed', reason: 'no_users' }
    }

    // Start sync
    await db.CasSyncState.startSync(userIds.length)
    log.info({ totalUsers: userIds.length, startIndex }, 'Starting CAS sync')

    const stats = {
      totalUsers: allUserIds.length,
      usersWithMessages: 0,
      messagesProcessed: 0,
      signaturesAdded: 0,
      signaturesUpdated: 0
    }

    let lastProcessedUserId = 0
    let processedCount = 0

    // Process in batches
    for (let i = 0; i < userIds.length; i += CONFIG.batchSize) {
      if (stopRequested) {
        // Persist progress before stopping
        log.info({ processedCount }, 'Sync stopped by request')
        await db.CasSyncState.updateProgress(lastProcessedUserId, {
          ...stats,
          processedCount
        })
        await db.CasSyncState.setStatus('stopped')
        return { status: 'stopped', stats, processedCount }
      }

      const batch = userIds.slice(i, i + CONFIG.batchSize)

      // Process batch with concurrency limit
      for (let j = 0; j < batch.length; j += CONFIG.concurrency) {
        if (stopRequested) break
        const chunk = batch.slice(j, j + CONFIG.concurrency)
        const batchStats = await processBatch(chunk, db)

        // Aggregate stats
        stats.usersWithMessages += batchStats.usersWithMessages
        stats.messagesProcessed += batchStats.messagesProcessed
        stats.signaturesAdded += batchStats.signaturesAdded
        stats.signaturesUpdated += batchStats.signaturesUpdated
      }

      lastProcessedUserId = batch[batch.length - 1]
      processedCount = i + batch.length

      // Update progress
      await db.CasSyncState.updateProgress(lastProcessedUserId, {
        ...stats,
        processedCount
      })

      log.debug(
        { processed: processedCount, total: userIds.length, ...stats },
        'Batch progress'
      )
    }

    // Complete sync
    await db.CasSyncState.completeSync(stats)
    log.info(stats, 'CAS sync completed')

    return { status: 'completed', stats }
  } catch (error) {
    log.error({ err: error.message, stack: error.stack }, 'CAS sync failed')
    await db.CasSyncState.setStatus('failed', error.message)
    return { status: 'failed', error: error.message }
  }
}

/**
 * Get current sync statistics
 * @param {Object} db
 * @returns {Promise<Object>}
 */
async function getStats (db) {
  const state = await db.CasSyncState.getState()
  return {
    status: state.status,
    lastSyncAt: state.lastSyncAt,
    stats: state.stats,
    currentBatch: state.currentBatch,
    error: state.error
  }
}

/**
 * Request graceful stop of current sync
 */
function stopSync () {
  stopRequested = true
  log.info('Stop requested')
}

/**
 * Start periodic sync with interval
 * @param {Object} db
 * @returns {NodeJS.Timeout|null}
 */
function startPeriodicSync (db) {
  if (!CONFIG.enabled) {
    log.info('CAS sync is disabled')
    return null
  }

  const intervalMs = CONFIG.intervalHours * 60 * 60 * 1000

  // Run first sync after 1 minute (let bot fully start)
  setTimeout(() => {
    runSync(db).catch(err => {
      log.error({ err: err.message }, 'Periodic sync failed')
    })
  }, 60 * 1000)

  // Then run at intervals
  const intervalId = setInterval(() => {
    runSync(db).catch(err => {
      log.error({ err: err.message }, 'Periodic sync failed')
    })
  }, intervalMs)

  log.info({ intervalHours: CONFIG.intervalHours }, 'Started periodic CAS sync')

  return intervalId
}

/**
 * Delay utility
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  runSync,
  getStats,
  stopSync,
  startPeriodicSync,
  // For testing
  fetchCasExport,
  fetchUserMessages,
  addCasMessage,
  CONFIG
}
