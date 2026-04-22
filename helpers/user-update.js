const { calculateReputation } = require('./reputation')
const { trackIdentity, updateUniqueness } = require('./spam-signals')

/**
 * Check if session reputation is stale compared to DB
 * This catches cross-session updates (e.g., spam detected in another group)
 */
const isReputationStale = async (ctx, sessionUser) => {
  if (!sessionUser?.reputation?.lastCalculated) return true

  try {
    // Quick check: fetch only reputation timestamp from DB
    const dbUser = await ctx.db.User.findOne(
      { telegram_id: ctx.from.id },
      { 'reputation.lastCalculated': 1, 'globalStats.spamDetections': 1 }
    ).lean()

    if (!dbUser?.reputation?.lastCalculated) return false

    const sessionTime = new Date(sessionUser.reputation.lastCalculated).getTime()
    const dbTime = new Date(dbUser.reputation.lastCalculated).getTime()

    // Stale if DB was updated after session load
    // Also check if spamDetections increased (critical change)
    const dbSpam = dbUser.globalStats?.spamDetections || 0
    const sessionSpam = sessionUser.globalStats?.spamDetections || 0

    return dbTime > sessionTime || dbSpam > sessionSpam
  } catch (error) {
    return false // On error, don't force refresh
  }
}

module.exports = async (ctx) => {
  if (!ctx.from) return

  let user
  let needsDbRefresh = false

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

    // Check for cross-session reputation updates (spam detected in other groups)
    // Only check periodically to avoid DB overhead (every 30 seconds)
    const lastStaleCheck = ctx.session._reputationStaleCheck || 0
    const staleCheckInterval = 30 * 1000

    if (Date.now() - lastStaleCheck > staleCheckInterval) {
      ctx.session._reputationStaleCheck = Date.now()
      needsDbRefresh = await isReputationStale(ctx, user)
    }

    if (needsDbRefresh) {
      // Refresh full user data from DB
      const freshUser = await ctx.db.User.findOne({ telegram_id: ctx.from.id })
      if (freshUser) {
        user = freshUser
        ctx.session.userInfo = user
      }
    }

    user.first_name = ctx.from.first_name
    user.last_name = ctx.from.last_name
    user.username = ctx.from.username

    // updatedAt is normally populated by mongoose timestamps. If somehow absent
    // (legacy doc, manual insert) treat the user as needing a refresh and skip
    // the .getTime() call that would crash on a non-Date value.
    const updateInterval = 60 * 1000
    const updatedAtMs = user.updatedAt instanceof Date ? user.updatedAt.getTime() : 0
    if ((updatedAtMs + updateInterval) < Date.now()) {
      user.updatedAt = new Date()
    }
  }

  // Track identity changes (name/username) — runs for every interaction, not
  // only group messages. Catches spammers that rotate identities in DM as well.
  trackIdentity(user, ctx.from)

  // Update global stats for group messages
  if (ctx.chat && ['group', 'supergroup'].includes(ctx.chat.type)) {
    const groupId = ctx.chat.id

    // Initialize globalStats if not exists.
    // firstSeen seed: prefer the document's true age over "now" — otherwise
    // every existing 1M-user record we never tracked before would look like
    // it just appeared today, falsely triggering the sleeper-account rule.
    if (!user.globalStats) {
      const firstActMs = user.first_act ? user.first_act * 1000 : null
      const seededFirstSeen = user.createdAt ? new Date(user.createdAt)
        : firstActMs ? new Date(firstActMs)
          : new Date()
      user.globalStats = {
        totalMessages: 0,
        groupsActive: 0,
        groupsList: [],
        firstSeen: seededFirstSeen,
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

    // Update text uniqueness (rolling window of normalized hashes).
    // Strong signal for mass-blast spam: a user with 100 messages and 1%
    // uniqueness is almost certainly running a campaign.
    const message = ctx.message || ctx.editedMessage
    const messageText = (message && (message.text || message.caption)) || ''
    if (messageText) {
      updateUniqueness(user, messageText)
    }

    // Recalculate reputation periodically (every 10 messages or if stale)
    const lastCalc = user.reputation && user.reputation.lastCalculated
    const shouldRecalculate =
      (user.globalStats.totalMessages % 10 === 0) ||
      !lastCalc ||
      (Date.now() - new Date(lastCalc).getTime() > 24 * 60 * 60 * 1000)

    if (shouldRecalculate) {
      user.reputation = calculateReputation(user.globalStats, ctx.from.id, {
        isGlobalBanned: user.isGlobalBanned
      })
    }
  }

  return user
}
