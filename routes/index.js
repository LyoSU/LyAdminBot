const { registerCommands } = require('./commands')
const { registerAdminRoutes } = require('./admin')
const { registerEvents } = require('./events')

/**
 * Register all routes on the bot
 */
const registerAllRoutes = (bot) => {
  registerCommands(bot)
  registerAdminRoutes(bot)
  registerEvents(bot)
}

module.exports = {
  registerAllRoutes,
  registerCommands,
  registerAdminRoutes,
  registerEvents
}
