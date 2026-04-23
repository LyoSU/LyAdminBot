const { bot: log } = require('../helpers/logger')
const { liftPmContext } = require('../helpers/menu/pm-context')

const handlers = new Map()

const registerInputHandler = (type, fn) => {
  if (typeof fn !== 'function') throw new Error(`pending-input: handler for "${type}" must be a function`)
  handlers.set(type, fn)
}

const isExpired = (pi) => pi.expiresAt && pi.expiresAt.getTime() < Date.now()

const pendingInputMiddleware = async (ctx, next) => {
  if (!ctx.message || !ctx.message.text) return next()
  // In PM the group session never binds ctx.group; lift the deep-link target
  // group so admins can complete force-reply flows started from /settings.
  await liftPmContext(ctx)
  const pi = ctx.group && ctx.group.info && ctx.group.info.settings && ctx.group.info.settings.pendingInput
  if (!pi || !pi.userId) return next()

  const reply = ctx.message.reply_to_message
  if (!reply || !pi.promptMsgId || reply.message_id !== pi.promptMsgId) return next()

  if (!ctx.from || ctx.from.id !== pi.userId) return next()
  if (isExpired(pi)) {
    delete ctx.group.info.settings.pendingInput
    return next()
  }

  const handler = handlers.get(pi.type)
  if (!handler) return next()

  // Claim the message (clear pendingInput, do not call next)
  delete ctx.group.info.settings.pendingInput
  try {
    await handler(ctx, ctx.message.text, pi)
  } catch (err) {
    log.error({ err: err.message, type: pi.type }, 'pending-input handler error')
  }

  // Persist mutations (we skipped next(), so dataPersistence never runs).
  // Mirrors the save semantics of middlewares/data-persistence.js saveGroupInfo().
  if (ctx.group && ctx.group.info && typeof ctx.group.info.save === 'function' && !ctx.group.info.isSaving) {
    ctx.group.info.isSaving = true
    try { await ctx.group.info.save() } catch (err) { log.debug({ err: err.message, type: pi.type }, 'pending-input: group save failed') } finally { ctx.group.info.isSaving = false }
  }
  // Intentionally do NOT call next — the message was consumed
}

module.exports = { pendingInputMiddleware, registerInputHandler }
