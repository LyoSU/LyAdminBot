const {
  handleMessage,
  handleWelcome,
  handleAdminJsonReset,
  handleReport,
  isBotMentionReport,
  handleChatMember,
  handleMessageReaction
} = require('../handlers')

/**
 * Register all event handlers
 */
const registerEvents = (bot) => {
  // Document upload (for JSON settings restore)
  bot.on('document', handleAdminJsonReset)

  // chat_member — user join/leave/status transitions.
  // Used for first-message-latency tracking (see handlers/chat-member.js).
  // Registered BEFORE 'new_chat_members' because telegraf fires both for
  // legacy-group joins; chat_member is the richer payload.
  bot.on('chat_member', handleChatMember)

  // message_reaction — crowd-sourced spam-feedback signal (see
  // handlers/message-reaction.js). 3+ distinct trusted users hitting a
  // message with 👎💩🤮🤬🤡 within 5min triggers retroactive delete.
  bot.on('message_reaction', handleMessageReaction)

  // New chat members welcome (legacy `new_chat_members` message event)
  bot.on('new_chat_members', handleWelcome)

  // Handle @botusername mentions as report (in reply to a message)
  bot.on('text', (ctx, next) => {
    if (isBotMentionReport(ctx)) {
      return handleReport(ctx)
    }
    return next()
  })

  // Generic message handler (must be last)
  bot.on('message', handleMessage)
}

module.exports = { registerEvents }
