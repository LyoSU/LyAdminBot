// Process-level shutdown plumbing.
//
// Two responsibilities:
//
//   1. Graceful shutdown on SIGTERM / SIGINT — k8s, pm2, or Ctrl-C.
//      Stops Telegraf polling, tears down background jobs, closes
//      Mongo. Has a hard deadline: if the orderly path takes longer
//      than SHUTDOWN_TIMEOUT_MS, we exit anyway, because hanging is
//      worse than losing one in-flight tick.
//
//   2. Process-wide error nets:
//      - unhandledRejection: on Node ≥15 the default behaviour is to
//        crash. We log the reason first so the incident has a stack
//        trace before we go down. The crash itself is intentional —
//        a leaked rejection means our state may be corrupt, and a
//        restart is safer than continuing.
//      - uncaughtException: same shape, less common.
//
// Without (1), kubernetes/pm2 wait the full TERM->KILL grace period
// (30s default) before sending SIGKILL — which loses any work that
// was about to write to Mongo. Without (2), today's "Failed to
// compile template" bug COULD have leaked and crashed the bot
// silently before the per-vote try/catch was added.

const { bot: log } = require('../helpers/logger')

const SHUTDOWN_TIMEOUT_MS = 10 * 1000

let shuttingDown = false

/**
 * Wire process-level handlers. Called once from bot.js after the bot
 * has launched and background jobs are running.
 *
 * @param {Object} args
 * @param {import('telegraf').Telegraf} args.bot - launched Telegraf instance
 * @param {Object} args.db - Mongoose connection bundle (must expose .connection.close())
 * @param {{ stop: () => Promise<void> }} args.backgroundJobs - handle from startBackgroundJobs
 */
const installShutdownHandlers = ({ bot, db, backgroundJobs }) => {
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true

    log.info({ signal }, 'Shutdown requested')

    // Hard deadline: even if one of the steps below hangs, we must
    // exit. process.exit(0) lets node print a non-error termination.
    const killSwitch = setTimeout(() => {
      log.warn({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Shutdown deadline reached, exiting forcefully')
      process.exit(0)
    }, SHUTDOWN_TIMEOUT_MS)
    if (typeof killSwitch.unref === 'function') killSwitch.unref()

    try {
      // Order matters: stop accepting new work first, then drain.
      // 1. Telegraf — stops polling / webhook listener.
      try {
        bot.stop(signal)
        log.debug('telegraf stopped')
      } catch (err) {
        log.warn({ err }, 'telegraf.stop() failed')
      }

      // 2. Background jobs — clears every interval/timeout we own so
      //    no new ticks fire while we drain.
      if (backgroundJobs && typeof backgroundJobs.stop === 'function') {
        try {
          await backgroundJobs.stop()
          log.debug('background jobs stopped')
        } catch (err) {
          log.warn({ err }, 'backgroundJobs.stop() failed')
        }
      }

      // 3. Mongo — close after the producers above have stopped, so
      //    no in-flight save() races the close.
      if (db && db.connection && typeof db.connection.close === 'function') {
        try {
          await db.connection.close()
          log.debug('mongo connection closed')
        } catch (err) {
          log.warn({ err }, 'mongo close failed')
        }
      }

      log.info('Shutdown complete')
    } finally {
      clearTimeout(killSwitch)
      // Give pino a tick to flush before we exit.
      setImmediate(() => process.exit(0))
    }
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))

  // Process-wide error nets. We log + exit rather than swallow:
  // continuing past an unhandled rejection is gambling with state.
  process.on('unhandledRejection', (reason, promise) => {
    log.error({ err: reason, promise }, 'unhandledRejection — exiting')
    // Trigger graceful shutdown; if it deadlocks, killSwitch fires.
    shutdown('unhandledRejection')
  })
  process.on('uncaughtException', (err) => {
    log.error({ err }, 'uncaughtException — exiting')
    shutdown('uncaughtException')
  })

  log.debug('Shutdown handlers installed')
}

module.exports = {
  installShutdownHandlers,
  SHUTDOWN_TIMEOUT_MS
}
