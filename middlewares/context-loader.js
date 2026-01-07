const {
  updateUser,
  updateGroup,
  updateGroupMember
} = require('../helpers')

/**
 * Load user info into session and set locale
 */
const loadUserContext = async (ctx) => {
  ctx.session.userInfo = await updateUser(ctx)

  if (ctx.session.userInfo.locale) {
    ctx.i18n.locale(ctx.session.userInfo.locale)
  }
}

/**
 * Load group info into session
 */
const loadGroupContext = async (ctx) => {
  if (!ctx.group || !ctx.from) return

  ctx.group.info = await updateGroup(ctx)

  if (!ctx.group.members) {
    ctx.group.members = []
  }

  ctx.group.members[ctx.from.id] = await updateGroupMember(ctx)

  // Group locale overrides user locale
  if (ctx.group.info.settings.locale) {
    ctx.i18n.locale(ctx.group.info.settings.locale)
  }
}

/**
 * Context loader middleware
 * Loads user, group, and member data into session
 */
const contextLoader = async (ctx, next) => {
  // Skip if no session or no user (e.g., channel posts, service messages)
  if (!ctx.session || !ctx.from) {
    return next(ctx)
  }

  await loadUserContext(ctx)
  await loadGroupContext(ctx)

  return next(ctx)
}

module.exports = contextLoader
