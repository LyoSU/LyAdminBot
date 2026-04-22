/**
 * Canonical "is the sender of this message a group admin?" check.
 *
 * Handles the anonymous-admin edge case properly:
 *
 *   When an admin enables the "Remain Anonymous" option in a group,
 *   Telegram delivers their messages with:
 *     ctx.message.from.id        = 1087968824  (Group Anonymous Bot)
 *     ctx.message.sender_chat.id = ctx.chat.id (the group itself)
 *
 *   `getChatMember(chat, 1087968824)` doesn't return useful data for
 *   admin verification, so historical call sites that only used the
 *   getChatMember path silently denied admin access to every anonymous
 *   admin. That's a UX bug (admin commands don't work for them) and
 *   also the root cause of "admin commands fail for hidden owners".
 *
 *   The correct shortcut: if sender_chat is the chat itself, the sender
 *   is BY CONSTRUCTION an admin — Telegram doesn't let non-admins post
 *   that way. No Bot-API call needed.
 *
 *   Analogous situation for user-posting-as-channel in discussion
 *   groups: sender_chat.type === 'channel' and sender_chat.id !== chat.id
 *   means the user is posting in the name of their own channel, which
 *   is NOT an admin privilege — treated as non-admin here.
 */
const { bot: botLog } = require('./logger')

const ADMIN_STATUSES = new Set(['creator', 'administrator'])

const isSenderAdmin = async (ctx) => {
  if (!ctx || !ctx.chat || !ctx.message) return false

  const senderChat = ctx.message.sender_chat
  if (senderChat && senderChat.id === ctx.chat.id) {
    // Anonymous admin posting as the group itself.
    return true
  }

  const fromId = ctx.message.from && ctx.message.from.id
  if (!fromId) return false

  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, fromId)
    return Boolean(member && ADMIN_STATUSES.has(member.status))
  } catch (err) {
    botLog.warn({ err: err.message, chatId: ctx.chat.id, userId: fromId }, 'isSenderAdmin failed')
    return false
  }
}

module.exports = { isSenderAdmin, ADMIN_STATUSES }
