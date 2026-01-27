const rateLimit = require('telegraf-ratelimit')
const { onlyGroup } = require('../middlewares')
const {
  handleStart,
  handleHelp,
  handlePing,
  handleSetLanguage,
  handleWebAuth,
  handleQuote,
  handleKick,
  handleDelete,
  handleTop,
  handleTopBanan,
  handleMyStats,
  handleExtraList,
  handleReport,
  handleBanan
} = require('../handlers')

/**
 * Rate limiter for banan command
 * One banan per 3 seconds per group
 */
const bananRateLimit = rateLimit({
  window: 3 * 1000,
  limit: 1,
  keyGenerator: (ctx) => ctx.chat.id,
  onLimitExceeded: (ctx) => ctx.deleteMessage()
})

/**
 * Register all user commands
 */
const registerCommands = (bot) => {
  // Basic commands (any chat)
  bot.command('start', handleStart)
  bot.command('help', handleHelp)
  bot.command('ping', handlePing)
  bot.command('lang', handleSetLanguage)
  bot.command('web', handleWebAuth)
  bot.command('q', handleQuote)
  bot.command('del', handleDelete)

  // Group-only commands
  bot.command('kick', onlyGroup, handleKick)
  bot.command('top', onlyGroup, handleTop)
  bot.command('top_banan', onlyGroup, handleTopBanan)
  bot.command('mystats', onlyGroup, handleMyStats)
  bot.command('extras', onlyGroup, handleExtraList)
  bot.command('report', onlyGroup, handleReport)

  // Banan with rate limiting
  bot.command('banan', onlyGroup, bananRateLimit, handleBanan)

  // Language selection callback
  bot.action(/set_language:(.*)/, handleSetLanguage)
}

module.exports = { registerCommands }
