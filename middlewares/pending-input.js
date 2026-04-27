const { bot: log } = require('../helpers/logger')
const { liftPmContext } = require('../helpers/menu/pm-context')

const handlers = new Map()

const registerInputHandler = (type, fn) => {
  if (typeof fn !== 'function') throw new Error(`pending-input: handler for "${type}" must be a function`)
  handlers.set(type, fn)
}

const isExpired = (pi) => pi.expiresAt && pi.expiresAt.getTime() < Date.now()

// Extract a normalized input payload from the reply message. Handlers receive
// both the legacy `text` arg (empty string when no text) and a richer `input`
// object so they can switch on media type when they care.
const extractInput = (msg) => {
  if (!msg) return null
  if (msg.animation) return { kind: 'animation', fileId: msg.animation.file_id, text: msg.caption || '' }
  if (msg.video) return { kind: 'video', fileId: msg.video.file_id, text: msg.caption || '' }
  if (msg.sticker) return { kind: 'sticker', fileId: msg.sticker.file_id, text: '' }
  if (msg.document) return { kind: 'document', fileId: msg.document.file_id, text: msg.caption || '' }
  if (msg.photo && Array.isArray(msg.photo) && msg.photo.length) {
    return { kind: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id, text: msg.caption || '' }
  }
  if (typeof msg.text === 'string') return { kind: 'text', fileId: null, text: msg.text }
  return null
}

const pendingInputMiddleware = async (ctx, next) => {
  if (!ctx.message) return next()
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

  const input = extractInput(ctx.message)
  if (!input) return next()

  // Claim the message (clear pendingInput, do not call next)
  delete ctx.group.info.settings.pendingInput
  try {
    await handler(ctx, input.text, pi, input)
  } catch (err) {
    log.error({ err, type: pi.type }, 'pending-input handler error')
  }

  // Persist mutations (we skipped next(), so dataPersistence never runs).
  // Mirrors the save semantics of middlewares/data-persistence.js saveGroupInfo().
  if (ctx.group && ctx.group.info && typeof ctx.group.info.save === 'function' && !ctx.group.info.isSaving) {
    ctx.group.info.isSaving = true
    try { await ctx.group.info.save() } catch (err) { log.debug({ err, type: pi.type }, 'pending-input: group save failed') } finally { ctx.group.info.isSaving = false }
  }
  // Intentionally do NOT call next — the message was consumed
}

module.exports = { pendingInputMiddleware, registerInputHandler }
