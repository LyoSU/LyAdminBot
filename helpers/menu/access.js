const ADMIN_STATUSES = new Set(['creator', 'administrator'])

const isAdmin = async (ctx) => {
  if (!ctx || !ctx.chat || !ctx.from) return false
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id)
    return Boolean(member && ADMIN_STATUSES.has(member.status))
  } catch {
    return false
  }
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
      return { ok: false, toastKey: 'menu.access.denied' }
  }
}

module.exports = { checkAccess, isAdmin, isInitiator }
