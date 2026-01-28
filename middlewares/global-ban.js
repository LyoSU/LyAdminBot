const { globalBan: log } = require('../helpers/logger')
const { humanizeReason } = require('../helpers/spam-check')
const { scheduleDeletion } = require('../helpers/message-cleanup')

const GLOBAL_BAN_DURATION_HOURS = 24
const NOTIFICATION_DELETE_DELAY_MS = 30 * 1000

/**
 * Check if global ban has expired
 */
const isGlobalBanExpired = (globalBanDate) => {
  if (!globalBanDate) return true
  const hoursSinceBan = (Date.now() - new Date(globalBanDate).getTime()) / (1000 * 60 * 60)
  return hoursSinceBan >= GLOBAL_BAN_DURATION_HOURS
}

/**
 * Clear expired global ban from user
 */
const clearExpiredBan = async (ctx) => {
  const userInfo = ctx.session.userInfo

  userInfo.isGlobalBanned = false
  userInfo.globalBanReason = undefined
  userInfo.globalBanDate = undefined

  await userInfo.save().catch(err => log.error({ err: err.message }, 'Failed to clear expired ban'))

  log.info({ userId: ctx.from.id }, 'Cleared expired global ban')
}

/**
 * Check if group has global ban enabled
 */
const isGlobalBanEnabledInGroup = (ctx) => {
  return ctx.group?.info?.settings?.openaiSpamCheck?.globalBan !== false
}

/**
 * Execute ban actions: delete message, kick user, notify
 * Each operation is independent - failures don't block other actions
 */
const executeBanActions = async (ctx, reason) => {
  const userId = ctx.from.id
  const chatId = ctx.chat.id

  let deleted = false
  let kicked = false

  // 1. Delete the spam message
  try {
    await ctx.telegram.deleteMessage(chatId, ctx.message.message_id)
    deleted = true
  } catch (err) {
    log.warn({ err: err.message, userId }, 'Failed to delete message')
  }

  // 2. Kick the user (critical action)
  try {
    await ctx.telegram.kickChatMember(chatId, userId)
    kicked = true
  } catch (err) {
    log.error({ err: err.message, userId, chatId }, 'Failed to kick user')
  }

  // 3. Notify group and schedule auto-delete (only if kick succeeded)
  if (kicked) {
    try {
      const msg = await ctx.replyWithHTML(ctx.i18n.t('global_ban.kicked', {
        name: ctx.from.first_name,
        reason: humanizeReason(reason, ctx.i18n)
      }))

      if (msg && ctx.db) {
        scheduleDeletion(ctx.db, {
          chatId,
          messageId: msg.message_id,
          delayMs: NOTIFICATION_DELETE_DELAY_MS,
          source: 'global_ban'
        }, ctx.telegram).catch(err => log.warn({ err: err.message }, 'Failed to schedule notification deletion'))
      }
    } catch (err) {
      log.warn({ err: err.message, userId }, 'Failed to send notification')
    }
  }

  // Log if critical action failed
  if (!kicked) {
    log.warn({ userId, deleted, kicked }, 'Global ban incomplete')
  }

  return { deleted, kicked }
}

/**
 * Handle active global ban
 */
const handleActiveBan = async (ctx) => {
  if (!isGlobalBanEnabledInGroup(ctx)) {
    log.debug({ userId: ctx.from.id, group: ctx.chat.title }, 'Global ban disabled in group')
    return false
  }

  const userInfo = ctx.session.userInfo

  log.warn({
    userId: ctx.from.id,
    reason: userInfo.globalBanReason
  }, 'Enforcing global ban')

  await executeBanActions(ctx, userInfo.globalBanReason)
  return true
}

/**
 * Global ban check middleware
 * Blocks globally banned users from participating in groups
 */
module.exports = async (ctx, next) => {
  // Skip non-message contexts or missing session
  if (!ctx.message || !ctx.from || !ctx.session?.userInfo) {
    return next()
  }

  const userInfo = ctx.session.userInfo

  // Not banned - continue
  if (!userInfo.isGlobalBanned) {
    return next()
  }

  // Ban expired - clear and continue
  if (isGlobalBanExpired(userInfo.globalBanDate)) {
    await clearExpiredBan(ctx)
    return next()
  }

  // Enforce ban
  const wasBanned = await handleActiveBan(ctx)

  if (wasBanned) {
    ctx.state = ctx.state || {}
    ctx.state.isSpam = true
  }

  return next()
}
