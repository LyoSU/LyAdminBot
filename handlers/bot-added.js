const { bot: botLog } = require('../helpers/logger')
const e = require('../helpers/emoji-map')

// Fallback messages when i18n is not available
const FALLBACK_MESSAGES = {
  as_admin: `${e.check} Bot added as admin. Anti-spam protection is now active.`,
  need_admin: `${e.warn} Bot needs admin rights with "Ban users" permission to work.`,
  promoted: `${e.check} Admin rights received. Anti-spam protection is now active.`,
  demoted: `${e.warn} Admin rights removed. Anti-spam protection is disabled.`
}

/**
 * Get i18n message with fallback
 */
const getMessage = (ctx, key) => {
  if (ctx.i18n && typeof ctx.i18n.t === 'function') {
    return ctx.i18n.t(`bot_added.${key}`)
  }
  return FALLBACK_MESSAGES[key] || `[${key}]`
}

/**
 * Handle bot being added to a group
 * Sends a short welcome message explaining what the bot does
 */
module.exports = async (ctx) => {
  const update = ctx.update.my_chat_member
  if (!update) return

  const chat = update.chat
  const newMember = update.new_chat_member
  const oldMember = update.old_chat_member

  // Only handle groups
  if (!['group', 'supergroup'].includes(chat.type)) return

  // Check if this is about our bot
  if (newMember.user.id !== ctx.botInfo.id) return

  const oldStatus = oldMember && oldMember.status
  const wasInChat = ['member', 'administrator', 'creator'].includes(oldStatus)
  const isNowInChat = ['member', 'administrator', 'creator'].includes(newMember.status)
  const isAdmin = newMember.status === 'administrator'
  const hadRestrictPermission = oldMember && oldMember.can_restrict_members
  const hasRestrictPermission = newMember.can_restrict_members

  // Bot was just added to the group
  if (!wasInChat && isNowInChat) {
    try {
      if (isAdmin) {
        // Bot added as admin - ready to work
        await ctx.telegram.sendMessage(
          chat.id,
          getMessage(ctx, 'as_admin'),
          { parse_mode: 'HTML' }
        )
      } else {
        // Bot added but not as admin - needs permissions
        await ctx.telegram.sendMessage(
          chat.id,
          getMessage(ctx, 'need_admin'),
          { parse_mode: 'HTML' }
        )
      }
      botLog.info({ chatId: chat.id, isAdmin }, 'Bot added to group')
    } catch (err) {
      botLog.error({ err, chatId: chat.id }, 'Failed to send welcome message')
    }
    return
  }

  // Bot was promoted to admin (got restrict permission)
  if (wasInChat && !hadRestrictPermission && hasRestrictPermission) {
    try {
      await ctx.telegram.sendMessage(
        chat.id,
        getMessage(ctx, 'promoted'),
        { parse_mode: 'HTML' }
      )
      botLog.info({ chatId: chat.id }, 'Bot promoted to admin')
    } catch (err) {
      botLog.error({ err, chatId: chat.id }, 'Failed to send promotion message')
    }
    return
  }

  // Bot lost admin rights
  if (wasInChat && hadRestrictPermission && !hasRestrictPermission) {
    try {
      await ctx.telegram.sendMessage(
        chat.id,
        getMessage(ctx, 'demoted'),
        { parse_mode: 'HTML' }
      )
      botLog.info({ chatId: chat.id }, 'Bot demoted from admin')
    } catch (err) {
      botLog.error({ err, chatId: chat.id }, 'Failed to send demotion message')
    }
  }
}
