/**
 * Utility functions for identifying message senders
 * Handles both regular users and channel posts correctly
 */

/**
 * Check if a Telegram ID is a channel (negative, starts with -100)
 * @param {number} id - Telegram ID
 * @returns {boolean}
 */
const isChannelId = (id) => {
  return typeof id === 'number' && id < 0
}

/**
 * Check if message is from a channel (has sender_chat with channel type)
 * @param {Object} message - Telegram message object
 * @returns {boolean}
 */
const isChannelPost = (message) => {
  return !!(message?.sender_chat?.type === 'channel')
}

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
 * Get sender ID from context (handles both users and channels)
 * @param {Object} ctx - Telegraf context
 * @returns {number|null} - Sender ID (positive for users, negative for channels)
 */
const getSenderId = (ctx) => {
  const message = ctx.message || ctx.editedMessage
  if (!message) return ctx.from?.id || null

  // Channel post: use sender_chat.id
  if (message.sender_chat?.id) {
    return message.sender_chat.id
  }

  // Regular user message
  return ctx.from?.id || null
}

/**
 * Get sender info object from context
 * @param {Object} ctx - Telegraf context
 * @returns {Object|null} - Sender info (user object or sender_chat object)
 */
const getSenderInfo = (ctx) => {
  const message = ctx.message || ctx.editedMessage
  if (!message) return ctx.from || null

  // Channel post: use sender_chat
  if (message.sender_chat?.id) {
    return message.sender_chat
  }

  // Regular user message
  return ctx.from || null
}

/**
 * Get comprehensive sender data
 * @param {Object} ctx - Telegraf context
 * @returns {Object} - { id, info, isChannel, isLinkedChannel, isAnonymousAdmin }
 */
const getSender = (ctx) => {
  const message = ctx.message || ctx.editedMessage
  const senderChat = message?.sender_chat

  const isChannel = !!(senderChat?.type === 'channel')
  const id = senderChat?.id || ctx.from?.id || null
  const info = senderChat || ctx.from || null

  return {
    id,
    info,
    isChannel,
    isLinkedChannel: isLinkedChannelPost(ctx),
    isAnonymousAdmin: isAnonymousAdmin(ctx)
  }
}

module.exports = {
  isChannelId,
  isChannelPost,
  isLinkedChannelPost,
  isAnonymousAdmin,
  getSenderId,
  getSenderInfo,
  getSender
}
