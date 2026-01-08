const { db: dbLog } = require('../helpers/logger')

/**
 * Save user info with conflict prevention
 */
const saveUserInfo = (ctx) => {
  if (!ctx.session || !ctx.session.userInfo || ctx.session.userInfo.isSaving) {
    return null
  }

  ctx.session.userInfo.isSaving = true

  return ctx.session.userInfo.save()
    .then(() => { ctx.session.userInfo.isSaving = false })
    .catch((err) => {
      ctx.session.userInfo.isSaving = false
      // VersionError is expected during parallel requests - data will sync on next save
      if (err.name === 'VersionError') {
        dbLog.debug({ userId: ctx.session.userInfo.telegram_id }, 'User save conflict (will sync later)')
      } else {
        dbLog.error({ err }, 'User save error')
      }
    })
}

/**
 * Save group info with conflict prevention
 */
const saveGroupInfo = (ctx) => {
  if (!ctx.group || !ctx.group.info || ctx.group.info.isSaving) {
    return null
  }

  ctx.group.info.isSaving = true

  return ctx.group.info.save()
    .then(() => { ctx.group.info.isSaving = false })
    .catch(() => { ctx.group.info.isSaving = false })
}

/**
 * Save group member info with conflict prevention
 */
const saveGroupMember = (ctx) => {
  if (!ctx.group || !ctx.group.members || !ctx.from) {
    return null
  }

  const member = ctx.group.members[ctx.from.id]

  if (!member || member.isSaving) {
    return null
  }

  member.isSaving = true

  return member.save()
    .then(() => { member.isSaving = false })
    .catch(() => { member.isSaving = false })
}

/**
 * Data persistence middleware
 * Saves all modified data after request processing
 *
 * Uses Promise.allSettled to avoid parallel save conflicts
 */
const dataPersistence = async (ctx, next) => {
  // Process the request first
  await next(ctx)

  // Then save all modified data
  const savePromises = [
    saveUserInfo(ctx),
    saveGroupInfo(ctx),
    saveGroupMember(ctx)
  ].filter(Boolean)

  if (savePromises.length > 0) {
    await Promise.allSettled(savePromises)
  }
}

module.exports = dataPersistence
