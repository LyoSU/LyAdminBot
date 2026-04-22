module.exports = (ctx, targetId) => new Promise(async (resolve, reject) => {
  try {
    const memberId = targetId || ctx.from.id
    let groupMember

    if (!ctx.group.members[memberId]) {
      groupMember = await ctx.db.GroupMember.findOne({
        group: ctx.group.info.id,
        telegram_id: memberId
      })
    } else groupMember = ctx.group.members[memberId]

    if (!groupMember) {
      groupMember = new ctx.db.GroupMember()

      groupMember.group = ctx.group.info.id
      groupMember.telegram_id = memberId
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

    // First-message latency bookkeeping. If the user had a chat_member join
    // event earlier (joinedAt set) this is the first time we see them
    // actually post — compute the delta. If joinedAt is missing (we weren't
    // subscribed yet or the event was before the bot joined), we just
    // stamp firstMessageAt for reference and skip the latency.
    if (!groupMember.stats.firstMessageAt) {
      const now = new Date()
      groupMember.stats.firstMessageAt = now
      if (groupMember.stats.joinedAt instanceof Date) {
        const latencyMs = now.getTime() - groupMember.stats.joinedAt.getTime()
        if (latencyMs >= 0) {
          groupMember.stats.firstMessageLatencyMs = latencyMs
        }
      }
    }

    const updateInterval = 60 * 1000

    if ((groupMember.updatedAt.getTime() + updateInterval) < Date.now()) {
      groupMember.updatedAt = new Date()
    }

    resolve(groupMember)
  } catch (error) {
    reject(error)
  }
})
