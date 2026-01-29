// How often to refresh linked_chat_id (24 hours)
const LINKED_CHAT_REFRESH_INTERVAL = 24 * 60 * 60 * 1000

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

  if (!group.username && !group.invite_link) {
    group.invite_link = await ctx.telegram.exportChatInviteLink(ctx.chat.id).catch(() => {})
  }

  group.stats.messagesCount += 1

  if (ctx.message && ctx.message.text && ctx.message.text.length > 0) {
    group.stats.textTotal += ctx.message.text.length
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
