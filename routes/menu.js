const { handleCallback } = require('../helpers/menu/router')
const { PREFIX } = require('../helpers/menu/keyboard')

const registerMenuRoutes = (bot) => {
  // Match any callback whose data starts with the menu prefix.
  // Using a RegExp constructed from the literal so future PREFIX changes propagate.
  const re = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  bot.action(re, handleCallback)
}

module.exports = { registerMenuRoutes }
