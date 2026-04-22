const { db: dbLog } = require('../helpers/logger')
const { isSystemSender } = require('../helpers/system-senders')

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
 * Save group member info with conflict prevention.
 *
 * Member-id resolution mirrors context-loader.loadGroupContext:
 *   - anonymous admin (sender_chat.id === chat.id)  → no member
 *   - external channel crosspost                    → sender_chat.id
 *   - system placeholder without sender_chat        → no member
 *   - ordinary user                                 → ctx.from.id
 */
const saveGroupMember = (ctx) => {
  if (!ctx.group || !ctx.group.members || !ctx.from) {
    return null
  }

  const message = ctx.message || ctx.editedMessage
  const senderChat = message && message.sender_chat
  let memberId
  if (senderChat && senderChat.id === ctx.chat.id) {
    return null
  } else if (senderChat && senderChat.type === 'channel') {
    memberId = senderChat.id
  } else if (isSystemSender(ctx)) {
    return null
  } else {
    memberId = ctx.from.id
  }

  const member = ctx.group.members[memberId]
  if (!member || member.isSaving) return null

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
