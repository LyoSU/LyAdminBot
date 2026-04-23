const { handleCallback } = require('../helpers/menu/router')
const { PREFIX } = require('../helpers/menu/keyboard')
const { registerAll } = require('../helpers/menu/screens')
const { getPmTarget } = require('../helpers/menu/pm-context')

// In PM, menu callbacks need to know which group the admin is configuring.
// /start settings_<chatId> sets the pm-context target on entry; this lifter
// loads the target Group doc and exposes ctx.targetChatId for access.js.
// Without this, ctx.chat is the private DM and group_admin checks fail.
const liftPmTarget = async (ctx) => {
  if (!ctx.chat || ctx.chat.type !== 'private' || !ctx.from) return
  const targetChatId = getPmTarget(ctx.from.id)
  if (!targetChatId) return
  ctx.targetChatId = targetChatId
  if (!ctx.db || !ctx.db.Group) return
  try {
    const groupDoc = await ctx.db.Group.findOne({ group_id: targetChatId })
    if (groupDoc) {
      ctx.group = { info: groupDoc }
      // Mirror loadGroupContext behavior: group's settings.locale wins over
      // the user's TG language_code. Without this, every menu callback in PM
      // re-renders in the user's TG language even after they picked a
      // different language for the group.
      const groupLocale = groupDoc.settings && groupDoc.settings.locale
      if (groupLocale && ctx.i18n && typeof ctx.i18n.locale === 'function') {
        try { ctx.i18n.locale(groupLocale) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

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
  bot.action(re, async (ctx) => {
    await liftPmTarget(ctx)
    return handleCallback(ctx)
  })
}

module.exports = { registerMenuRoutes, liftPmTarget }
