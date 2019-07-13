module.exports = async (ctx) => new Promise(async (resolve, reject) => {
  let group

  if (!ctx.group.info) group = await ctx.db.Group.findOne({ group_id: ctx.chat.id })
  else group = ctx.group.info

  if (!group) {
    group = new ctx.db.Group()
    group.group_id = ctx.chat.id
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

  group.updatedAt = new Date()
  group.save()

  resolve(group)
})
