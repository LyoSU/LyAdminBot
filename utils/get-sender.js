/**
 * Utility functions for identifying message senders
 * Handles both regular users and channel posts correctly
 */

/**
 * Check if message is from the linked discussion channel
 * @param {Object} ctx - Telegraf context
 * @returns {boolean}
 */
const isLinkedChannelPost = (ctx) => {
  const message = ctx.message || ctx.editedMessage
  if (!message) return false

  // Primary check: Telegram's reliable flag
  if (message.is_automatic_forward) return true

  // Fallback: cached linked_chat_id
  const linkedChatId = ctx.group?.info?.linked_chat_id
  const senderChatId = message.sender_chat?.id

  return !!(linkedChatId && senderChatId && senderChatId === linkedChatId)
}

/**
 * Check if message is from anonymous admin (posting as group)
 * @param {Object} ctx - Telegraf context
 * @returns {boolean}
 */
const isAnonymousAdmin = (ctx) => {
  const message = ctx.message || ctx.editedMessage
  if (!message?.sender_chat) return false

  return message.sender_chat.id === ctx.chat?.id
}

/**
 * Get sender data from context (handles both users and channels)
 * @param {Object} ctx - Telegraf context
 * @returns {{ id: number|null, info: Object|null, isChannel: boolean, isLinkedChannel: boolean, isAnonymousAdmin: boolean }}
 */
const getSender = (ctx) => {
  const message = ctx.message || ctx.editedMessage
  const senderChat = message?.sender_chat

  return {
    id: senderChat?.id || ctx.from?.id || null,
    info: senderChat || ctx.from || null,
    isChannel: senderChat?.type === 'channel',
    isLinkedChannel: isLinkedChannelPost(ctx),
    isAnonymousAdmin: isAnonymousAdmin(ctx)
  }
}

module.exports = {
  isLinkedChannelPost,
  isAnonymousAdmin,
  getSender
}
