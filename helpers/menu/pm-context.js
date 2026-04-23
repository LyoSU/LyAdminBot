// PM-target tracking — when a user opens an admin panel in private chat
// via a deep-link (e.g. /start settings_<chatId>), we remember which group
// they're configuring. Subsequent menu callbacks in PM use this target so
// access checks and data reads point at the right group instead of the
// private chat (where the user is "creator" of their own DM, but that means
// nothing).
//
// In-memory LRU. Survives across DM clicks within the bot process; on
// restart the user just re-clicks the deep-link from the group.

const { LRUCache } = require('lru-cache')

const TTL_MS = 30 * 60 * 1000  // 30 min — long enough for an admin to step away

const cache = new LRUCache({ max: 2000, ttl: TTL_MS })

const setPmTarget = (userId, chatId) => {
  if (!userId || !chatId) return
  cache.set(userId, chatId)
}

const getPmTarget = (userId) => {
  if (!userId) return null
  return cache.get(userId) || null
}

const clearPmTarget = (userId) => cache.delete(userId)

const clearAll = () => cache.clear()

module.exports = { setPmTarget, getPmTarget, clearPmTarget, clearAll, _cache: cache }
