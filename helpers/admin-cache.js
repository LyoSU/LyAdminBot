// Cache admin-status lookups for menu access checks.
//
// Why: every menu callback in PM (settings flow) re-asks Telegram
// "is this user admin in <group>?". Without a cache that's an HTTP round-trip
// per click. 5-minute TTL is short enough to honor demotions reasonably fast
// while shielding the bot from per-click latency.

const { LRUCache } = require('lru-cache')

const ADMIN_STATUSES = new Set(['creator', 'administrator'])
const TTL_MS = 5 * 60 * 1000

const cache = new LRUCache({ max: 5000, ttl: TTL_MS })

const key = (chatId, userId) => `${chatId}:${userId}`

const isUserAdmin = async (telegram, chatId, userId) => {
  if (!telegram || !chatId || !userId) return false
  const k = key(chatId, userId)
  const cached = cache.get(k)
  if (cached !== undefined) return cached
  try {
    const member = await telegram.getChatMember(chatId, userId)
    const ok = Boolean(member && ADMIN_STATUSES.has(member.status))
    cache.set(k, ok)
    return ok
  } catch {
    return false
  }
}

const setKnownAdmin = (chatId, userId, isAdmin) => {
  cache.set(key(chatId, userId), Boolean(isAdmin))
}

const invalidate = (chatId, userId) => {
  cache.delete(key(chatId, userId))
}

const clearAll = () => cache.clear()

module.exports = { isUserAdmin, setKnownAdmin, invalidate, clearAll, _cache: cache }
