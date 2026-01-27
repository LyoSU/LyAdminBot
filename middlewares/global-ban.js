const { globalBan: log } = require('../helpers/logger')
const { humanizeReason } = require('../helpers/spam-check')

const GLOBAL_BAN_DURATION_HOURS = 24

/**
 * Check if global ban has expired
 */
const isGlobalBanExpired = (globalBanDate) => {
  if (!globalBanDate) return true

  const now = new Date()
  const banTime = new Date(globalBanDate)
  const hoursDiff = (now - banTime) / (1000 * 60 * 60)

  return hoursDiff >= GLOBAL_BAN_DURATION_HOURS
}

/**
 * Clear expired global ban from user
 */
const clearExpiredBan = async (ctx) => {
  const userInfo = ctx.session.userInfo

  userInfo.isGlobalBanned = false
  userInfo.globalBanReason = undefined
  userInfo.globalBanDate = undefined

  await userInfo.save().catch(err => log.error({ err }, 'Failed to clear expired ban'))

  log.info({
    userId: ctx.from.id,
    firstName: ctx.from.first_name
  }, 'Cleared expired global ban')
}

/**
 * Check if group has global ban enabled
 */
const isGlobalBanEnabledInGroup = (ctx) => {
  return ctx.group &&
         ctx.group.info &&
         ctx.group.info.settings &&
         ctx.group.info.settings.openaiSpamCheck &&
         ctx.group.info.settings.openaiSpamCheck.globalBan !== false
}

/**
 * Execute ban actions: delete message, kick user, notify
 */
const executeBanActions = async (ctx, reason) => {
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id)
    await ctx.telegram.kickChatMember(ctx.chat.id, ctx.from.id)
    await ctx.replyWithHTML(ctx.i18n.t('global_ban.kicked', {
      name: ctx.from.first_name,
      reason: humanizeReason(reason, ctx.i18n)
    }))
  } catch (error) {
    log.error({
      err: error.message,
      userId: ctx.from.id
    }, 'Failed to kick globally banned user')
  }
}

/**
 * Handle active global ban
 * Returns true if user was banned
 */
const handleActiveBan = async (ctx) => {
  const userInfo = ctx.session.userInfo
  const banDate = new Date(userInfo.globalBanDate)
  const timeLeft = GLOBAL_BAN_DURATION_HOURS - ((new Date() - banDate) / (1000 * 60 * 60))

  if (!isGlobalBanEnabledInGroup(ctx)) {
    log.debug({
      userId: ctx.from.id,
      firstName: ctx.from.first_name,
      groupTitle: ctx.chat.title
    }, 'User globally banned but group has global ban disabled')
    return false
  }

  log.warn({
    userId: ctx.from.id,
    firstName: ctx.from.first_name,
    reason: userInfo.globalBanReason,
    timeLeftHours: timeLeft.toFixed(1)
  }, 'User globally banned by AI, banning in current group')

  await executeBanActions(ctx, userInfo.globalBanReason)
  return true
}

/**
 * Global ban check middleware
 * Checks if user is globally banned and handles accordingly
 *
 * Sets ctx.state.isSpam = true if user was banned
 */
const globalBanCheck = async (ctx, next) => {
  // Only check messages from users
  if (!ctx.message || !ctx.from || !ctx.session || !ctx.session.userInfo) {
    return next(ctx)
  }

  const userInfo = ctx.session.userInfo

  // Not globally banned - continue
  if (!userInfo.isGlobalBanned) {
    return next(ctx)
  }

  // Check if ban expired
  if (isGlobalBanExpired(userInfo.globalBanDate)) {
    await clearExpiredBan(ctx)
    return next(ctx)
  }

  // Handle active ban
  const wasBanned = await handleActiveBan(ctx)

  if (wasBanned) {
    // Initialize state if needed
    if (!ctx.state) ctx.state = {}
    ctx.state.isSpam = true
  }

  return next(ctx)
}

module.exports = globalBanCheck
