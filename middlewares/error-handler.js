const { bot: botLog } = require('../helpers/logger')

/**
 * Error messages that indicate bot should leave the chat
 */
const LEAVE_CHAT_ERRORS = [
  'CHAT_WRITE_FORBIDDEN',
  'bot was kicked',
  'bot is not a member',
  'have no rights to send a message',
  'need administrator rights'
]

/**
 * Check if error requires bot to leave the chat
 */
const shouldLeaveChat = (errorMsg) => {
  return LEAVE_CHAT_ERRORS.some(err => errorMsg.includes(err))
}

/**
 * Handle bot leaving chat gracefully
 */
const handleLeaveChat = async (ctx) => {
  const chatId = ctx.chat && ctx.chat.id
  const chatTitle = (ctx.chat && ctx.chat.title) || 'unknown'

  if (!chatId) return

  botLog.warn({ chatId }, 'Cannot write to chat, leaving...')

  try {
    await ctx.telegram.leaveChat(chatId)
    botLog.info({ chatId, chatTitle }, 'Left chat')
  } catch (leaveError) {
    botLog.error({ chatId, err: leaveError.message }, 'Failed to leave chat')
  }
}

/**
 * Global error handler middleware
 * Catches all errors and handles them appropriately
 */
const errorHandler = (ctx, next) => {
  next().catch(async (error) => {
    const errorMsg = error.message || error.description || ''

    if (shouldLeaveChat(errorMsg)) {
      await handleLeaveChat(ctx)
      return
    }

    botLog.error({ err: error }, 'Unhandled error')
  })

  return true
}

module.exports = errorHandler
