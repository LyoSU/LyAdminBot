// Small wrappers around the Node Timer API used for our recurring
// background jobs. Centralized so the same hygiene applies everywhere:
//
//   - `.unref()` on every infinite-loop interval, so SIGTERM (k8s,
//     pm2, plain Ctrl-C) can actually exit the process. Without it,
//     `setInterval(...)` keeps the event loop alive forever.
//
//   - `.catch()` on async callbacks, so an in-flight rejection doesn't
//     bubble up as an `unhandledRejection` — which on Node ≥15 is a
//     hard process kill by default.
//
// Defensive `typeof X.unref === 'function'` checks because some test
// runners shim Timer with objects that don't carry the full Node API.

/**
 * Mark a Timer as "non-blocking" for graceful shutdown purposes.
 * Returns the same Timer so it can be assigned in one expression.
 *
 *   const t = unrefSafe(setInterval(..., 1000))
 *
 * @param {*} timer - Object returned by setInterval / setTimeout.
 * @returns {*} The same timer.
 */
const unrefSafe = (timer) => {
  if (timer && typeof timer.unref === 'function') timer.unref()
  return timer
}

/**
 * setInterval wrapper for async callbacks. The callback is invoked
 * each tick; any returned promise has `.catch()` attached so a reject
 * is logged-and-swallowed instead of crashing the process.
 *
 * Behaviour matches what `digest-scheduler` does by hand. The interval
 * is `.unref()`-ed by default; pass `unref: false` if the caller
 * really needs to keep the loop alive.
 *
 * @param {() => (void | Promise<void>)} fn - Tick body.
 * @param {number} ms - Interval length in milliseconds.
 * @param {Object} [opts]
 * @param {Object} [opts.log] - Logger with .error(); used to report rejections.
 * @param {string} [opts.label] - Label included in the rejection log line.
 * @param {boolean} [opts.unref=true] - Whether to call `.unref()`.
 * @returns {NodeJS.Timer} The interval id (so callers can clearInterval).
 */
const safeInterval = (fn, ms, { log, label, unref = true } = {}) => {
  const id = setInterval(() => {
    let result
    try {
      result = fn()
    } catch (err) {
      if (log) log.error({ err, label }, 'Interval tick threw synchronously')
      return
    }
    if (result && typeof result.catch === 'function') {
      result.catch((err) => {
        if (log) log.error({ err, label }, 'Interval tick rejected')
      })
    }
  }, ms)
  if (unref) unrefSafe(id)
  return id
}

/**
 * setTimeout counterpart of safeInterval. Same async-safety contract,
 * one-shot. Useful for delayed startup syncs ("first run after 1m,
 * then on the regular interval").
 */
const safeTimeout = (fn, ms, { log, label, unref = true } = {}) => {
  const id = setTimeout(() => {
    let result
    try {
      result = fn()
    } catch (err) {
      if (log) log.error({ err, label }, 'Timeout body threw synchronously')
      return
    }
    if (result && typeof result.catch === 'function') {
      result.catch((err) => {
        if (log) log.error({ err, label }, 'Timeout body rejected')
      })
    }
  }, ms)
  if (unref) unrefSafe(id)
  return id
}

module.exports = {
  unrefSafe,
  safeInterval,
  safeTimeout
}
