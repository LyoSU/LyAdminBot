/**
 * Menu router — dispatches `m:v1:<screenId>:<action>:<args>` callbacks.
 *
 * Screen contract:
 *   {
 *     id: string,                             // e.g. 'settings.antispam'
 *     access: 'public' | 'group_admin' | 'initiator' | 'group_admin_or_initiator',
 *     accessOpts?: (ctx) => object | Promise<object>,  // OPTIONAL: produce
 *       // access opts (e.g. { initiatorId }). Called before access check.
 *       // Screens that use `initiator` or `group_admin_or_initiator` MUST
 *       // implement this to return { initiatorId: <userId> }.
 *     render: (ctx, state) => ({ text, keyboard }) | Promise<...>,
 *     handle: (ctx, action, args) => result | Promise<result>
 *   }
 *
 * handle() return contract (truth table):
 *
 *   result                            | renders? | toast       | cb answered?
 *   ----------------------------------+----------+-------------+--------------
 *   'render'                          | yes      | no          | empty
 *   { render: true, state: {...} }    | yes      | no          | empty
 *   { render: false, toast: 'key' }   | no       | 'key'       | 'key'
 *   { toast: 'key' }                  | yes      | 'key'       | 'key'
 *   { silent: true }                  | yes      | no          | NOT answered
 *   { silent: true, render: false }   | no       | no          | NOT answered
 *   null / undefined                  | no       | no          | empty
 *
 * Reserved screenIds: '_close' (deletes message), '_noop' (silent ack).
 *
 * Error paths:
 *   parse failure   → cbQuery 'menu.unknown'
 *   unknown screen  → cbQuery 'menu.unknown'
 *   access denied   → cbQuery with access rule's toastKey (alert)
 *   handler throws  → log + cbQuery 'menu.error'
 */

const { getMenu } = require('./registry')
const { checkAccess } = require('./access')
const { editHTML } = require('../reply-html')
const { PREFIX } = require('./keyboard')
const { bot: log } = require('../logger')

const RESERVED_CLOSE = '_close'
const RESERVED_NOOP = '_noop'

const parseCallback = (data) => {
  if (typeof data !== 'string' || !data.startsWith(PREFIX)) {
    return { ok: false }
  }
  const rest = data.slice(PREFIX.length)
  const parts = rest.split(':')
  if (parts.length === 0 || parts[0] === '') return { ok: false }

  // Reserved single-token actions
  if (parts.length === 1 && (parts[0] === RESERVED_CLOSE || parts[0] === RESERVED_NOOP)) {
    return { ok: true, screenId: parts[0], action: '', args: [] }
  }
  if (parts.length < 2) return { ok: false }

  const [screenId, action, ...args] = parts
  return { ok: true, screenId, action, args }
}

const renderScreen = async (ctx, screen, state) => {
  const view = await screen.render(ctx, state || {})
  if (!view || !view.text) return
  const opts = {}
  if (view.keyboard) opts.reply_markup = view.keyboard
  try {
    await editHTML(ctx, ctx.callbackQuery.message.message_id, view.text, opts)
  } catch (err) {
    if (!err.message || !err.message.includes('message is not modified')) {
      log.warn({ err: err.message, screenId: screen.id }, 'menu render: editHTML failed')
    }
  }
}

const handleCallback = async (ctx) => {
  const data = ctx.callbackQuery && ctx.callbackQuery.data
  const parsed = parseCallback(data)
  if (!parsed.ok) {
    return ctx.answerCbQuery(ctx.i18n.t('menu.unknown')).catch(() => {})
  }

  // Reserved actions
  if (parsed.screenId === RESERVED_CLOSE) {
    try { await ctx.deleteMessage() } catch { /* ignore */ }
    return ctx.answerCbQuery().catch(() => {})
  }
  if (parsed.screenId === RESERVED_NOOP) {
    return ctx.answerCbQuery().catch(() => {})
  }

  const screen = getMenu(parsed.screenId)
  if (!screen) {
    return ctx.answerCbQuery(ctx.i18n.t('menu.unknown')).catch(() => {})
  }

  const accessOpts = typeof screen.accessOpts === 'function'
    ? await screen.accessOpts(ctx)
    : {}
  const access = await checkAccess(ctx, screen.access, accessOpts || {})
  if (!access.ok) {
    return ctx.answerCbQuery(ctx.i18n.t(access.toastKey), { show_alert: true }).catch(() => {})
  }

  try {
    let result
    if (parsed.action === 'open') {
      result = 'render'
    } else {
      result = await screen.handle(ctx, parsed.action, parsed.args)
    }

    if (result === 'render' || (result && result.render !== false)) {
      await renderScreen(ctx, screen, result && result.state)
    }
    if (result && result.toast) {
      await ctx.answerCbQuery(ctx.i18n.t(result.toast)).catch(() => {})
    } else if (!result || !result.silent) {
      await ctx.answerCbQuery().catch(() => {})
    }
  } catch (err) {
    log.error({ err: err.message, screenId: parsed.screenId, action: parsed.action }, 'menu handler error')
    await ctx.answerCbQuery(ctx.i18n.t('menu.error'), { show_alert: false }).catch(() => {})
  }
}

module.exports = { parseCallback, handleCallback, renderScreen, PREFIX }
