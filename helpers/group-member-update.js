module.exports = (ctx) => new Promise(async (resolve, reject) => {
  let groupMember

  if (!ctx.group.member) {
    groupMember = await ctx.db.GroupMember.findOne({
      group: ctx.group.info.id,
      telegram_id: ctx.from.id,
    })
  }
  else groupMember = ctx.group.member

  if (!groupMember) {
    groupMember = new ctx.db.GroupMember()

    groupMember.group = ctx.group.info.id
    groupMember.telegram_id = ctx.from.id
    groupMember.updatedAt = 0
  }

  if (groupMember.banan.stack > 0) {
    const day = 86400
    const now = new Date()

    const delta = (now - groupMember.banan.time) / 1000

    if (delta > day) {
      groupMember.banan.stack -= 1
      groupMember.banan.time = now
    }
  }

  groupMember.stats.messagesCount += 1

  if (ctx.message && ctx.message.text && ctx.message.text.length > 0) {
    groupMember.stats.textTotal += ctx.message.text.length
  }

  const updateInterval = 60 * 1000

  if ((groupMember.updatedAt.getTime() + updateInterval) < Date.now()) {
    groupMember.updatedAt = new Date()
  }

  resolve(groupMember)
})
