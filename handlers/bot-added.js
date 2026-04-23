const { bot: botLog } = require('../helpers/logger')
const e = require('../helpers/emoji-map')
const botPermissions = require('../helpers/bot-permissions')
const onboarding = require('../helpers/menu/screens/onboarding')
const { replyHTML } = require('../helpers/reply-html')

// Fallback messages when i18n is not available
const FALLBACK_MESSAGES = {
  as_admin: `${e.check} Bot added as admin. Anti-spam protection is now active.`,
  need_admin: `${e.warn} Bot needs admin rights with "Ban users" permission to work.`,
  promoted: `${e.check} Admin rights received. Anti-spam protection is now active.`,
  demoted: `${e.warn} Admin rights removed. Anti-spam protection is disabled.`
}

/**
 * Get i18n message with fallback.
 *
 * Resilient to two failure modes both seen on prod:
 *   - ctx.i18n missing entirely (middleware ordering)
 *   - ctx.i18n.t('key') returning '' or the key itself (raw i18n instance
 *     queried before per-request language context is bound — causes
 *     "Bad Request: message text is empty" when the result lands in
 *     sendMessage)
 * In either case we fall back to the English bundle rather than sending
 * a blank notification to the group.
 */
const getMessage = (ctx, key) => {
  const fallback = FALLBACK_MESSAGES[key] || `[${key}]`
  if (ctx.i18n && typeof ctx.i18n.t === 'function') {
    const localized = ctx.i18n.t(`bot_added.${key}`)
    if (typeof localized === 'string' && localized.trim() && localized.trim() !== `bot_added.${key}`) {
      return localized
    }
  }
  return fallback
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

  // Always refresh the per-chat bot-permissions cache so the spam-check
  // pipeline can skip heavy LLM work in chats where we can't act. The
  // my_chat_member payload carries the exact ChatMemberAdministrator
  // fields we need (can_restrict_members / can_delete_messages).
  botPermissions.setFromMember(chat.id, newMember)

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
        // Bot added as admin → onboarding wizard (3-button card with
        // current defaults). Falls back to the plain `as_admin` notice if
        // the i18n isn't available (e.g. my_chat_member arrived before the
        // i18n middleware could attach to this ctx — shouldn't happen, but
        // we guard anyway).
        if (ctx.i18n && typeof ctx.i18n.t === 'function') {
          const view = onboarding.renderView(ctx)
          // ctx.reply isn't wired for my_chat_member contexts; use
          // replyHTML + explicit chat.id. (ctx.chat *is* set on
          // my_chat_member, so replyHTML's ctx.chat.id lookup works.)
          await replyHTML(ctx, view.text, { reply_markup: view.keyboard })
        } else {
          await ctx.telegram.sendMessage(
            chat.id,
            getMessage(ctx, 'as_admin'),
            { parse_mode: 'HTML' }
          )
        }
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

  // Bot was promoted to admin (got restrict permission). Show the full
  // onboarding card — same trigger as "added-as-admin" from the user's POV.
  if (wasInChat && !hadRestrictPermission && hasRestrictPermission) {
    try {
      if (ctx.i18n && typeof ctx.i18n.t === 'function') {
        const view = onboarding.renderView(ctx)
        await replyHTML(ctx, view.text, { reply_markup: view.keyboard })
      } else {
        await ctx.telegram.sendMessage(
          chat.id,
          getMessage(ctx, 'promoted'),
          { parse_mode: 'HTML' }
        )
      }
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
