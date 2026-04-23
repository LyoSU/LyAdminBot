// Menu-router access guards.
//
// Distinct from helpers/is-sender-admin.js because they operate in different
// contexts:
//   - is-sender-admin.js: MESSAGE updates. Reads ctx.message + sender_chat
//     to handle anonymous admins (sender_chat.id === chat.id shortcut).
//   - This file: CALLBACK_QUERY updates. ctx.message is absent. Telegram
//     resolves the real clicker into ctx.from even for anonymous admins,
//     so a plain getChatMember(chat, ctx.from.id) is sufficient and the
//     sender_chat shortcut would actively break (no ctx.message to read).
//
// Do not "consolidate" by reusing isSenderAdmin here.

const { bot: log } = require('../logger')
const adminCache = require('../admin-cache')

const isAdmin = async (ctx) => {
  if (!ctx || !ctx.from) return false
  // PM with a deep-link target group → check admin in THAT group, not in
  // the private chat with the bot (where every user is "creator" of their
  // own DM, which is meaningless). The pm-context middleware in
  // routes/menu.js sets ctx.targetChatId before this runs.
  const chatId = ctx.targetChatId || (ctx.chat && ctx.chat.id)
  if (!chatId) return false
  return adminCache.isUserAdmin(ctx.telegram, chatId, ctx.from.id)
}

const isInitiator = (ctx, initiatorId) => {
  return Boolean(initiatorId && ctx.from && ctx.from.id === initiatorId)
}

const checkAccess = async (ctx, rule, opts = {}) => {
  switch (rule) {
    case 'public':
      return { ok: true }
    case 'group_admin':
      return (await isAdmin(ctx))
        ? { ok: true }
        : { ok: false, toastKey: 'menu.access.only_admins' }
    case 'initiator':
      return isInitiator(ctx, opts.initiatorId)
        ? { ok: true }
        : { ok: false, toastKey: 'menu.access.only_initiator' }
    case 'group_admin_or_initiator':
      if (isInitiator(ctx, opts.initiatorId)) return { ok: true }
      if (await isAdmin(ctx)) return { ok: true }
      return { ok: false, toastKey: 'menu.access.only_initiator_or_admin' }
    default:
      // Log so screen.access typos (e.g. 'group_admni') don't silently deny in prod.
      log.warn({ rule }, 'menu/access: unknown access rule, denying')
      return { ok: false, toastKey: 'menu.access.denied' }
  }
}

module.exports = { checkAccess, isAdmin, isInitiator }
