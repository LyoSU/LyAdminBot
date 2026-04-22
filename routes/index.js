const { registerCommands } = require('./commands')
const { registerAdminRoutes } = require('./admin')
const { registerEvents } = require('./events')
const { registerMenuRoutes } = require('./menu')

/**
 * Register all routes on the bot
 */
const registerAllRoutes = (bot) => {
  registerCommands(bot)
  registerAdminRoutes(bot)
  registerMenuRoutes(bot)
  registerEvents(bot)
}

module.exports = {
  registerAllRoutes,
  registerCommands,
  registerAdminRoutes,
  registerMenuRoutes,
  registerEvents
}
