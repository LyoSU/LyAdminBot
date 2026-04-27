// Centralised registry of every recurring background job the bot
// owns (cleanup queue, expired-vote resolver, ban-database sync,
// weekly admin digest). Two reasons to keep them in one place:
//
//   1. Visibility — one file lists every long-running task. Anyone
//      reading bot.js doesn't have to chase intervals across helpers.
//
//   2. Lifecycle — startBackgroundJobs returns a `stop()` function
//      that tears every job down. The graceful-shutdown handler
//      (SIGTERM/SIGINT) calls it so we exit cleanly on k8s/pm2,
//      rather than relying purely on `.unref()` to let Node die.
//
// Each job here is responsible for its own per-tick error isolation
// (see helpers/timers.js#safeInterval); this module only orchestrates
// startup and shutdown order.

const { processExpiredVotes } = require('../handlers')
const { startCleanupInterval, stopCleanupInterval } = require('../helpers/message-cleanup')
const { startDigestScheduler } = require('../helpers/digest-scheduler')
const { startPeriodicSync: startBanDatabaseSync } = require('../helpers/ban-database-sync')
const { safeInterval } = require('../helpers/timers')
const { bot: botLog } = require('../helpers/logger')

const CLEANUP_INTERVAL_MS = 30 * 1000
const EXPIRED_VOTES_INTERVAL_MS = 60 * 1000

/**
 * @typedef {Object} BackgroundJobsDeps
 * @property {Object} db    - Mongoose connection bundle
 * @property {Object} telegram - Telegraf telegram client
 * @property {Object} i18n  - telegraf-i18n instance (must already
 *                            include `e: emojiMap` in templateData —
 *                            see bot.js:createI18n)
 */

/**
 * Start every recurring background job. Idempotent in spirit — calling
 * twice will start a second copy, so callers (bot.js + tests) own the
 * single-instance discipline.
 *
 * @param {BackgroundJobsDeps} deps
 * @returns {{ stop: () => Promise<void> }} Tear-down handle.
 */
const startBackgroundJobs = ({ db, telegram, i18n }) => {
  const stoppers = []

  // 1. Message cleanup queue — TTL-based deletions of old bot messages.
  startCleanupInterval(db, telegram, CLEANUP_INTERVAL_MS)
  stoppers.push(() => stopCleanupInterval())
  botLog.debug({ intervalMs: CLEANUP_INTERVAL_MS }, 'started: message-cleanup')

  // 2. Expired spam-vote resolver — flips timed-out votes to spam/clean.
  const expiredVotesId = safeInterval(
    () => processExpiredVotes(db, telegram, i18n),
    EXPIRED_VOTES_INTERVAL_MS,
    { log: botLog, label: 'expired-votes' }
  )
  stoppers.push(() => clearInterval(expiredVotesId))
  botLog.debug({ intervalMs: EXPIRED_VOTES_INTERVAL_MS }, 'started: expired-votes')

  // 3. Global ban database sync (CAS-style). startPeriodicSync already
  // skips itself if disabled by env, so we don't gate at this level.
  const banSyncId = startBanDatabaseSync(db)
  if (banSyncId) stoppers.push(() => clearInterval(banSyncId))
  botLog.debug('started: ban-database-sync')

  // 4. Weekly admin digest scheduler. Returns its own { stop } handle.
  const digestHandle = startDigestScheduler({ db, telegram, i18n })
  if (digestHandle && typeof digestHandle.stop === 'function') {
    stoppers.push(() => digestHandle.stop())
  }
  botLog.debug('started: digest-scheduler')

  return {
    stop: async () => {
      // Run stoppers in reverse-start order. Each is sync today, but
      // we await so adding an async one later doesn't bite us.
      for (let i = stoppers.length - 1; i >= 0; i--) {
        try {
          await stoppers[i]()
        } catch (err) {
          botLog.warn({ err }, 'background-jobs: stopper failed')
        }
      }
      botLog.debug('background-jobs stopped')
    }
  }
}

module.exports = {
  startBackgroundJobs,
  CLEANUP_INTERVAL_MS,
  EXPIRED_VOTES_INTERVAL_MS
}
