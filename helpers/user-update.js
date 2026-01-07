const { calculateReputation } = require('./reputation')

module.exports = async (ctx) => {
  if (!ctx.from) return

  let user

  if (!ctx.session.userInfo) {
    const now = Math.floor(new Date().getTime() / 1000)

    // Use findOneAndUpdate with upsert to avoid duplicate key errors
    user = await ctx.db.User.findOneAndUpdate(
      { telegram_id: ctx.from.id },
      {
        $set: {
          first_name: ctx.from.first_name,
          last_name: ctx.from.last_name,
          username: ctx.from.username,
          updatedAt: new Date()
        },
        $setOnInsert: {
          telegram_id: ctx.from.id,
          first_act: now
        }
      },
      {
        upsert: true,
        new: true,
        runValidators: true
      }
    )
  } else {
    user = ctx.session.userInfo
    user.first_name = ctx.from.first_name
    user.last_name = ctx.from.last_name
    user.username = ctx.from.username

    if (!user.updatedAt) user.updatedAt = 0

    const updateInterval = 60 * 1000

    if ((user.updatedAt.getTime() + updateInterval) < Date.now()) {
      user.updatedAt = new Date()
    }
  }

  // Update global stats for group messages
  if (ctx.chat && ['group', 'supergroup'].includes(ctx.chat.type)) {
    const groupId = ctx.chat.id

    // Initialize globalStats if not exists
    if (!user.globalStats) {
      user.globalStats = {
        totalMessages: 0,
        groupsActive: 0,
        groupsList: [],
        firstSeen: new Date(),
        lastActive: new Date(),
        spamDetections: 0,
        deletedMessages: 0,
        cleanMessages: 0,
        manualUnbans: 0
      }
    }

    // Increment total messages
    user.globalStats.totalMessages = (user.globalStats.totalMessages || 0) + 1
    user.globalStats.lastActive = new Date()

    // Track unique groups (max 20 recent)
    if (!user.globalStats.groupsList) {
      user.globalStats.groupsList = []
    }
    if (!user.globalStats.groupsList.includes(groupId)) {
      user.globalStats.groupsList.push(groupId)
      // Keep only last 20 groups
      if (user.globalStats.groupsList.length > 20) {
        user.globalStats.groupsList.shift()
      }
      user.globalStats.groupsActive = user.globalStats.groupsList.length
    }

    // Recalculate reputation periodically (every 10 messages or if stale)
    const lastCalc = user.reputation && user.reputation.lastCalculated
    const shouldRecalculate =
      (user.globalStats.totalMessages % 10 === 0) ||
      !lastCalc ||
      (Date.now() - new Date(lastCalc).getTime() > 24 * 60 * 60 * 1000)

    if (shouldRecalculate) {
      user.reputation = calculateReputation(user.globalStats, ctx.from.id)
    }
  }

  return user
}
