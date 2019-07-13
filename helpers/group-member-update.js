module.exports = async (ctx) => new Promise(async (resolve, reject) => {
  let groupMember

  if (!ctx.group.members[ctx.from.id]) {
    groupMember = await ctx.db.GroupMember.findOne({
      group: ctx.group.id,
      telegram_id: ctx.from.id,
    })
  }
  else groupMember = ctx.group.members[ctx.from.id]

  if (!groupMember) {
    groupMember = new ctx.db.GroupMember()

    groupMember.group = ctx.group.id
    groupMember.telegram_id = ctx.from.id
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

  groupMember.updatedAt = new Date()
  groupMember.save()

  resolve(groupMember)
})
