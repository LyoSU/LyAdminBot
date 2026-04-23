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

const TTL_MS = 30 * 60 * 1000 // 30 min — long enough for an admin to step away

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

// Inject the PM-target group into ctx for any code that needs group context
// in a private chat. No-op outside PM, when no target is stored, or when
// ctx.group is already loaded. Mirrors loadGroupContext for in-group msgs:
// sets ctx.group.info + ctx.targetChatId and aligns ctx.i18n.locale to the
// group's saved locale.
const liftPmContext = async (ctx) => {
  if (!ctx || !ctx.chat || ctx.chat.type !== 'private' || !ctx.from) return false
  if (ctx.group && ctx.group.info) return true
  const targetChatId = getPmTarget(ctx.from.id)
  if (!targetChatId) return false
  ctx.targetChatId = targetChatId
  if (!ctx.db || !ctx.db.Group) return true
  try {
    const groupDoc = await ctx.db.Group.findOne({ group_id: targetChatId })
    if (!groupDoc) return true
    ctx.group = { info: groupDoc }
    const groupLocale = groupDoc.settings && groupDoc.settings.locale
    if (groupLocale && ctx.i18n && typeof ctx.i18n.locale === 'function') {
      try { ctx.i18n.locale(groupLocale) } catch { /* ignore */ }
    }
    return true
  } catch {
    return false
  }
}

module.exports = { setPmTarget, getPmTarget, clearPmTarget, clearAll, liftPmContext, _cache: cache }
