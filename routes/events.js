const {
  handleMessage,
  handleWelcome,
  handleAdminJsonReset,
  handleReport,
  isBotMentionReport
} = require('../handlers')

/**
 * Register all event handlers
 */
const registerEvents = (bot) => {
  // Document upload (for JSON settings restore)
  bot.on('document', handleAdminJsonReset)

  // New chat members welcome
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
