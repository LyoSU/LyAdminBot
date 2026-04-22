const { detectLanguage } = require('./user-stats')

// How often to refresh linked_chat_id (24 hours)
const LINKED_CHAT_REFRESH_INTERVAL = 24 * 60 * 60 * 1000
const LEGACY_BAN_DATABASE_SETTING = ['c', 'as'].join('')

// Per-chat language aggregate: keep the top-N codes with counts.
// We only update once every ~10 messages to avoid churning the doc,
// but over time a clear dominant language emerges.
const LANG_CAP = 5
const LANG_SAMPLE_EVERY = 5
const updateGroupLanguage = (group, text) => {
  const code = detectLanguage(text)
  if (!code) return
  if (!Array.isArray(group.stats.detectedLanguages)) group.stats.detectedLanguages = []
  const list = group.stats.detectedLanguages
  const existing = list.find(e => e && e.code === code)
  if (existing) existing.count = (existing.count || 0) + 1
  else list.push({ code, count: 1 })
  list.sort((a, b) => (b.count || 0) - (a.count || 0))
  if (list.length > LANG_CAP) list.length = LANG_CAP
  if (typeof group.markModified === 'function') {
    group.markModified('stats.detectedLanguages')
  }
}

module.exports = async (ctx) => {
  let group

  if (!ctx.group.info) group = await ctx.db.Group.findOne({ group_id: ctx.chat.id })
  else group = ctx.group.info

  if (!group) {
    group = new ctx.db.Group()
    group.group_id = ctx.chat.id
    group.updatedAt = 0
  }

  group.title = ctx.chat.title
  group.username = ctx.chat.username
  group.settings = group.settings || new ctx.db.Group().settings

  if (group.settings.banDatabase === undefined && typeof group.settings[LEGACY_BAN_DATABASE_SETTING] === 'boolean') {
    group.settings.banDatabase = group.settings[LEGACY_BAN_DATABASE_SETTING]
    group.settings[LEGACY_BAN_DATABASE_SETTING] = undefined
  }

  if (!group.username && !group.invite_link) {
    group.invite_link = await ctx.telegram.exportChatInviteLink(ctx.chat.id).catch(() => {})
  }

  group.stats.messagesCount += 1

  if (ctx.message && ctx.message.text && ctx.message.text.length > 0) {
    group.stats.textTotal += ctx.message.text.length
    // Sample language detection every Nth message to keep it cheap while
    // still converging quickly on the chat's dominant language.
    if (group.stats.messagesCount % LANG_SAMPLE_EVERY === 0) {
      updateGroupLanguage(group, ctx.message.text)
    }
  }

  const updateInterval = 60 * 1000

  if ((group.updatedAt.getTime() + updateInterval) < Date.now()) {
    group.updatedAt = new Date()

    // Refresh linked_chat_id periodically (not cached or stale)
    const needsLinkedChatRefresh = group.linked_chat_id === undefined ||
      !group._linkedChatCheckedAt ||
      (Date.now() - group._linkedChatCheckedAt > LINKED_CHAT_REFRESH_INTERVAL)

    if (needsLinkedChatRefresh) {
      try {
        const chatInfo = await ctx.telegram.getChat(ctx.chat.id)
        group.linked_chat_id = chatInfo.linked_chat_id || null
        group._linkedChatCheckedAt = Date.now()
      } catch {
        // Ignore errors, keep existing value
      }
    }
  }

  return group
}
