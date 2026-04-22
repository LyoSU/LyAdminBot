/**
 * Per-chat cache of the bot's own admin permissions.
 *
 * Purpose: the spam-check pipeline runs expensive work (Qdrant embedding
 * lookup, LLM scoring with Grok/Gemini) on every incoming message. If
 * the bot has no restrict/delete rights in the chat, we can't act on
 * the verdict anyway — the whole pipeline is wasted compute. This
 * cache lets downstream code skip the heavy phases for those chats.
 *
 * Observed in prod logs for "Nukus OPTOM kosmetika N1":
 *   38 consecutive spam detections from one user, each ending in
 *   "No restrict permission" / "Cannot delete - no permission". Every
 *   one of those was 1-2s of Qdrant + 5s of LLM work that produced a
 *   verdict the bot could not enforce.
 *
 * Population:
 *   1. On every my_chat_member update for the bot, the handler calls
 *      `updateFromMember` with the new ChatMemberAdministrator shape.
 *   2. On cache miss inside a request, `resolve()` does a one-time
 *      getChatMember(chatId, botId) and caches the answer.
 *
 * Entries expire after TTL_MS (default 24h) so a late permission grant
 * is eventually picked up without a restart.
 */
const { LRUCache } = require('lru-cache')

const TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 10000

const cache = new LRUCache({ max: MAX_ENTRIES, ttl: TTL_MS, ttlAutopurge: false })

const ADMIN_STATUSES = new Set(['administrator', 'creator'])

/**
 * Normalize a ChatMember response into our permission record. Works
 * for both the `my_chat_member.new_chat_member` shape and the raw
 * getChatMember() return value — they share the same field names.
 */
const fromMember = (member) => {
  if (!member) return null
  const isAdmin = ADMIN_STATUSES.has(member.status)
  const canDelete = Boolean(member.can_delete_messages)
  const canRestrict = Boolean(member.can_restrict_members)
  return {
    isAdmin,
    canDelete,
    canRestrict,
    // A chat where the bot can neither delete messages nor restrict
    // users is effectively useless for enforcement — this flag lets
    // callers skip the heavy spam pipeline with a single check.
    canAct: canDelete || canRestrict
  }
}

const setFromMember = (chatId, member) => {
  const record = fromMember(member)
  if (!record || !chatId) return null
  cache.set(chatId, record)
  return record
}

const get = (chatId) => {
  if (!chatId) return null
  return cache.get(chatId) || null
}

/**
 * Best-effort lookup: return cached record, or fetch via Bot API and
 * cache. Returns null on any failure (callers must treat null as
 * "unknown" and fall back to the full pipeline).
 */
const resolve = async (telegram, chatId, botId) => {
  const cached = get(chatId)
  if (cached) return cached
  if (!telegram || !chatId || !botId) return null
  try {
    const member = await telegram.getChatMember(chatId, botId)
    return setFromMember(chatId, member)
  } catch (_err) {
    return null
  }
}

const _resetForTests = () => cache.clear()

module.exports = {
  fromMember,
  setFromMember,
  get,
  resolve,
  TTL_MS,
  _resetForTests
}
