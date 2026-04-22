const {
  updateUser,
  updateGroup,
  updateGroupMember
} = require('../helpers')
const { isSystemSender } = require('../helpers/system-senders')

/**
 * Load user info into session and set locale.
 * System senders (777000, anonymous-admin bot, channel bot) are
 * skipped — they're API placeholders, not individuals, and storing
 * them creates a phantom User doc that years of traffic write into.
 */
const loadUserContext = async (ctx) => {
  if (isSystemSender(ctx)) return
  ctx.session.userInfo = await updateUser(ctx)

  if (ctx.session.userInfo && ctx.session.userInfo.locale) {
    ctx.i18n.locale(ctx.session.userInfo.locale)
  }
}

/**
 * Load group info into session.
 *
 * Sender-identity resolution for per-member tracking:
 *   1. Anonymous admin (sender_chat.id === chat.id)  → skip entirely;
 *      the chat is posting as itself, there's no member to track.
 *   2. External channel crosspost (sender_chat.type === 'channel' and
 *      != chat.id)                                  → track under
 *      sender_chat.id, not ctx.from (which is the 1087968824 / 136817688
 *      bot placeholder).
 *   3. System sender (777000 etc.) without sender_chat → skip; these
 *      are service-message placeholders, not members.
 *   4. Regular user message                           → track under
 *      ctx.from.id as before.
 */
const loadGroupContext = async (ctx) => {
  if (!ctx.group || !ctx.from) return

  ctx.group.info = await updateGroup(ctx)

  if (!ctx.group.members) {
    ctx.group.members = []
  }

  const message = ctx.message || ctx.editedMessage
  const senderChat = message && message.sender_chat

  if (senderChat && senderChat.id === ctx.chat.id) {
    // Case 1: anonymous admin — nothing to record
  } else if (senderChat && senderChat.type === 'channel') {
    // Case 2: external channel crosspost
    ctx.group.members[senderChat.id] = await updateGroupMember(ctx, senderChat.id)
  } else if (isSystemSender(ctx)) {
    // Case 3: system sender placeholder with no sender_chat
  } else {
    // Case 4: ordinary user
    ctx.group.members[ctx.from.id] = await updateGroupMember(ctx)
  }

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
