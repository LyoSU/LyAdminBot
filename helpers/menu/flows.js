const { replyHTML } = require('../reply-html')

const INPUT_TTL_MS = 5 * 60 * 1000

const startInputFlow = async (ctx, { type, screen, prompt }) => {
  const sent = await replyHTML(ctx, prompt, {
    reply_markup: { force_reply: true, selective: true }
  })
  if (!ctx.group) ctx.group = { info: { settings: {} } }
  if (!ctx.group.info) ctx.group.info = { settings: {} }
  if (!ctx.group.info.settings) ctx.group.info.settings = {}
  ctx.group.info.settings.pendingInput = {
    userId: ctx.from.id,
    type,
    screen,
    promptMsgId: sent && sent.message_id,
    expiresAt: new Date(Date.now() + INPUT_TTL_MS)
  }
  return sent
}

const consumeInput = (ctx) => {
  const pi = ctx && ctx.group && ctx.group.info && ctx.group.info.settings && ctx.group.info.settings.pendingInput
  if (!pi || !pi.userId) return null
  if (pi.expiresAt && pi.expiresAt.getTime() < Date.now()) {
    delete ctx.group.info.settings.pendingInput
    return null
  }
  if (ctx.from && pi.userId !== ctx.from.id) return null
  delete ctx.group.info.settings.pendingInput
  return pi
}

module.exports = { startInputFlow, consumeInput, INPUT_TTL_MS }
