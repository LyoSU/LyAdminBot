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

// Configuration with defaults
const CONFIG = {
  enabled: process.env.CAS_SYNC_ENABLED === 'true',
  intervalHours: parseInt(process.env.CAS_SYNC_INTERVAL_HOURS) || 6,
  batchSize: parseInt(process.env.CAS_SYNC_BATCH_SIZE) || 1000,
  concurrency: parseInt(process.env.CAS_SYNC_CONCURRENCY) || 10,
  maxUsers: parseInt(process.env.CAS_SYNC_MAX_USERS) || 50000,
  requestDelay: parseInt(process.env.CAS_SYNC_REQUEST_DELAY) || 100 // ms between requests
}

// Base URL for CAS API
const CAS_API_BASE = 'https://api.cas.chat'

// HTTP client with reasonable timeouts (got v9 compatible)
const casApi = got.extend({
  timeout: 10000,
  retries: 2,
  throwHttpErrors: false
})

// Graceful stop flag
let stopRequested = false

/**
 * Fetch CAS export CSV and parse user IDs
 * Returns array of user IDs (numbers)
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
 * Returns { ok: boolean, messages: string[] }
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
    log.debug({ userId, err: error.message }, 'Failed to fetch user')
    return { ok: false, messages: [] }
  }
}

/**
 * Add a CAS message to signatures collection
 * CAS messages are auto-confirmed with synthetic chatId
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
          // CAS imports are immediately confirmed
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

    return result
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate - this is fine, just update
      return db.SpamSignature.findOneAndUpdate(
        { normalizedHash: signatures.normalizedHash },
        {
          $inc: { confirmations: 1 },
          $set: { lastSeenAt: new Date(), status: 'confirmed' }
        },
        { new: true }
      )
    }
    throw err
  }
}

/**
 * Process a batch of user IDs concurrently
 */
async function processBatch (userIds, db, stats) {
  const promises = userIds.map(async (userId) => {
    if (stopRequested) return

    const userData = await fetchUserMessages(userId)

    if (userData.ok && userData.messages.length > 0) {
      stats.usersWithMessages++

      for (const message of userData.messages.slice(0, 10)) { // Max 10 per user
        if (stopRequested) break

        try {
          const result = await addCasMessage(message, db)
          if (result) {
            stats.messagesProcessed++
            // Check if it was new or updated
            if (result.confirmations === 1) {
              stats.signaturesAdded++
            } else {
              stats.signaturesUpdated++
            }
          } else {
            stats.duplicatesSkipped++
          }
        } catch (err) {
          log.debug({ err: err.message }, 'Failed to add message')
        }
      }
    }

    // Tiny delay to avoid rate limiting
    await delay(CONFIG.requestDelay)
  })

  await Promise.all(promises)
}

/**
 * Run the full CAS synchronization
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
        if (resumeIndex > 0) {
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
      signaturesUpdated: 0,
      duplicatesSkipped: 0
    }

    // Process in batches
    for (let i = 0; i < userIds.length; i += CONFIG.batchSize) {
      if (stopRequested) {
        log.info({ processedCount: i }, 'Sync stopped by request')
        await db.CasSyncState.setStatus('stopped')
        return { status: 'stopped', stats }
      }

      const batch = userIds.slice(i, i + CONFIG.batchSize)
      const lastUserId = batch[batch.length - 1]

      // Process batch with concurrency limit
      for (let j = 0; j < batch.length; j += CONFIG.concurrency) {
        if (stopRequested) break
        const chunk = batch.slice(j, j + CONFIG.concurrency)
        await processBatch(chunk, db, stats)
      }

      // Update progress
      await db.CasSyncState.updateProgress(lastUserId, {
        ...stats,
        processedCount: i + batch.length
      })

      log.debug(
        { processed: i + batch.length, total: userIds.length, ...stats },
        'Batch progress'
      )
    }

    // Complete sync
    await db.CasSyncState.completeSync(stats)
    log.info(stats, 'CAS sync completed')

    return { status: 'completed', stats }
  } catch (error) {
    log.error({ err: error.message }, 'CAS sync failed')
    await db.CasSyncState.setStatus('failed', error.message)
    return { status: 'failed', error: error.message }
  }
}

/**
 * Get current sync statistics
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

// Utility
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
