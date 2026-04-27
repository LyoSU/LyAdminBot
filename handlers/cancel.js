// /cancel — clears any pending force-reply input flow for the caller.
// Mentioned in force-reply prompts ("Введи текст правила (або /cancel)") so
// users have a way out without having to send junk text.
//
// Works in both group context (ctx.group already loaded) and PM (we lift the
// deep-link target group so admins configuring via DM can also bail out).

const { replyHTML } = require('../helpers/reply-html')
const { liftPmContext } = require('../helpers/menu/pm-context')
const { bot: log } = require('../helpers/logger')

const consumeAndSave = async (ctx) => {
  const settings = ctx.group && ctx.group.info && ctx.group.info.settings
  const pi = settings && settings.pendingInput
  if (!pi || !pi.userId || !ctx.from || pi.userId !== ctx.from.id) return null

  const promptMsgId = pi.promptMsgId
  delete settings.pendingInput

  if (typeof ctx.group.info.save === 'function' && !ctx.group.info.isSaving) {
    ctx.group.info.isSaving = true
    try { await ctx.group.info.save() } catch (err) {
      log.debug({ err }, 'cancel: group save failed')
    } finally { ctx.group.info.isSaving = false }
  }
  return { promptMsgId }
}

module.exports = async (ctx) => {
  await liftPmContext(ctx)
  const consumed = await consumeAndSave(ctx)

  if (!consumed) {
    return replyHTML(ctx, ctx.i18n.t('menu.common.toast.cancelled')).catch(() => {})
  }

  // Best-effort cleanup of the original force-reply prompt — keeps the chat tidy.
  if (consumed.promptMsgId && ctx.chat) {
    ctx.telegram.deleteMessage(ctx.chat.id, consumed.promptMsgId).catch(() => {})
  }

  return replyHTML(ctx, ctx.i18n.t('menu.common.toast.cancelled')).catch(() => {})
}
