const { handleCallback } = require('../helpers/menu/router')
const { PREFIX } = require('../helpers/menu/keyboard')
const { registerAll } = require('../helpers/menu/screens')

const registerMenuRoutes = (bot) => {
  // Register all menu screens exactly once. Screen registration is global
  // module state (helpers/menu/registry.js) — idempotent per-boot, but if
  // registerMenuRoutes is ever called twice the registry will throw
  // "already registered". That's fine; we catch and ignore only the
  // specific dup case so tests that mount the router multiple times still
  // work.
  try {
    registerAll()
  } catch (err) {
    if (!/already registered/.test(err.message)) throw err
  }

  // Match any callback whose data starts with the menu prefix.
  // Using a RegExp constructed from the literal so future PREFIX changes propagate.
  const re = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  bot.action(re, handleCallback)
}

module.exports = { registerMenuRoutes }
