// Thin write/read wrappers around the ModLog collection.
//
// Backs the `settings.modlog` screen + audit-trail feature (§5.6 of the UX
// design). Write path is best-effort — logging failures must never break the
// action that triggered them. Read path supports time-range filtering and
// cursor-based pagination.
//
// Keep this module side-effect free beyond DB writes so it stays trivial to
// unit-test by passing in a mocked `db.ModLog` with the same signature.

const { bot: log } = require('./logger')

/**
 * Normalize an actor object into a pair of (id, name). Accepts either:
 *   - `null` / `undefined` → bot/system (nulls recorded).
 *   - A Telegram-user-ish `{ id, first_name, username, ... }`.
 *   - A pre-shaped `{ id, name }`.
 */
const normalizeActor = (actor) => {
  if (!actor) return { id: null, name: null }
  const id = actor.id !== undefined ? actor.id : (actor.telegram_id || null)
  const name = actor.name ||
    actor.first_name ||
    actor.username ||
    actor.title ||
    null
  return { id: id || null, name: name || null }
}

/**
 * Record a moderation / settings-change event.
 *
 * Returns the created row on success, `null` on failure (logged). Callers
 * should NEVER await this in a way that propagates exceptions — the action
 * (ban, kick, toggle) has already succeeded by the time this is called.
 *
 * @param {Object} db            - Mongoose-collections bag (`db.ModLog` req).
 * @param {Object} params
 * @param {number} params.chatId
 * @param {string} params.eventType  - One of ModLog.EVENT_TYPES.
 * @param {Object} [params.actor]    - { id, first_name/name } or null for bot.
 * @param {Object} [params.target]   - Same shape as actor. Optional.
 * @param {string} [params.action]   - Short description (≤100 chars stored).
 * @param {string} [params.reason]   - Longer context (≤200 chars stored).
 */
const logModEvent = async (db, {
  chatId,
  eventType,
  actor,
  target,
  action,
  reason
}) => {
  if (!db || !db.ModLog) return null
  if (!chatId || !eventType) return null
  try {
    const a = normalizeActor(actor)
    const t = normalizeActor(target)
    return await db.ModLog.create({
      chatId,
      eventType,
      actorId: a.id,
      actorName: a.name,
      targetId: t.id,
      targetName: t.name,
      action: action ? String(action).slice(0, 100) : '',
      reason: reason ? String(reason).slice(0, 200) : null
    })
  } catch (err) {
    log.debug({ err, eventType, chatId }, 'mod-log: write failed')
    return null
  }
}

/**
 * Fetch recent entries for a chat, newest-first, optionally limited to the
 * window `[since, now]`. `cursor` (a Date) lets callers paginate by handing
 * back the `timestamp` of the oldest row in the previous page.
 *
 * @returns {Promise<Array>} — always an array (possibly empty).
 */
const queryRecent = async (db, chatId, {
  since = null,
  limit = 10,
  cursor = null
} = {}) => {
  if (!db || !db.ModLog || !chatId) return []
  const query = { chatId }
  const timeBound = {}
  if (since instanceof Date) timeBound.$gte = since
  if (cursor instanceof Date) timeBound.$lt = cursor
  if (Object.keys(timeBound).length > 0) query.timestamp = timeBound
  try {
    return await db.ModLog
      .find(query)
      .sort({ timestamp: -1 })
      .limit(Math.max(1, Math.min(100, limit)))
      .lean()
  } catch (err) {
    log.debug({ err, chatId }, 'mod-log: query failed')
    return []
  }
}

/**
 * Count entries for a chat within an optional time window. Used to compute
 * pagination totals without streaming the whole result set.
 */
const countRecent = async (db, chatId, { since = null } = {}) => {
  if (!db || !db.ModLog || !chatId) return 0
  const query = { chatId }
  if (since instanceof Date) query.timestamp = { $gte: since }
  try {
    return await db.ModLog.countDocuments(query)
  } catch (err) {
    log.debug({ err, chatId }, 'mod-log: count failed')
    return 0
  }
}

// Convenience: compute the `since` Date for a UI range label.
const SINCE_FOR_RANGE = {
  '24h': () => new Date(Date.now() - 24 * 60 * 60 * 1000),
  '7d': () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  all: () => null
}

const rangeSince = (range) => {
  const fn = SINCE_FOR_RANGE[range]
  return fn ? fn() : null
}

module.exports = {
  logModEvent,
  queryRecent,
  countRecent,
  rangeSince,
  normalizeActor,
  SINCE_FOR_RANGE
}
