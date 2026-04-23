// /start handler — private card + deep-link routing, or a short group hint.
//
// Deep-links (from `?start=<payload>`):
//   help              → immediately render the /help tab-menu
//   settings_<chatId> → render the /settings root for that chat (in private).
//                       Falls back to a "coming soon" placeholder if Plan 4
//                       hasn't registered settings.root yet.
//   mystats_<chatId>  → forward to the regular /mystats handler, with chat
//                       context overridden to the target chat. Same fallback
//                       policy if the data isn't loadable.
//
// Unknown payload → behave like a regular /start (log debug, ignore).
//
// The payload parser is exported (`parseStartPayload`) so tests can exercise
// it without wiring up a Telegraf context.

const { userName } = require('../utils')
const { replyHTML } = require('../helpers/reply-html')
const { cb, btn, row } = require('../helpers/menu/keyboard')
const help = require('../helpers/menu/screens/help')
const langPicker = require('../helpers/menu/screens/lang-picker')
const { getMenu } = require('../helpers/menu/registry')
const { setPmTarget } = require('../helpers/menu/pm-context')
const { setKnownAdmin, isUserAdmin } = require('../helpers/admin-cache')
const modEvent = require('../helpers/mod-event')
const myStats = require('./my-stats')
const { bot: log } = require('../helpers/logger')

const parseStartPayload = (payload) => {
  if (!payload || typeof payload !== 'string') return { kind: 'none' }
  const trimmed = payload.trim()
  if (!trimmed) return { kind: 'none' }
  if (trimmed === 'help') return { kind: 'help' }
  const m = trimmed.match(/^(settings|mystats)_(-?\d+)$/)
  if (m) {
    return { kind: m[1], chatId: parseInt(m[2], 10) }
  }
  // mod_event_<eventId> — opens compact mod-event details in PM. Triggered
  // by the [🤨 За що?] URL button on group-side mod-event notifications.
  const me = trimmed.match(/^mod_event_([a-f0-9]+)$/i)
  if (me) {
    return { kind: 'mod_event', eventId: me[1] }
  }
  return { kind: 'unknown', raw: trimmed }
}

// Extract start payload from the command text. ctx.startPayload is only set
// by Telegraf's `bot.start()` convenience handler; we use `bot.command(…)`
// so we parse it ourselves. Format: `/start foo@BotName` or `/start foo`.
const readPayload = (ctx) => {
  if (ctx.startPayload) return ctx.startPayload
  const text = (ctx.message && ctx.message.text) || ''
  const parts = text.split(/\s+/)
  // parts[0] = "/start" or "/start@BotName"
  return parts.slice(1).join(' ')
}

const buildPrivateKeyboard = (ctx) => {
  const botUsername = (ctx.botInfo && ctx.botInfo.username) || 'LyAdminBot'
  return {
    inline_keyboard: [
      row(btn(ctx.i18n.t('menu.start.btn.add'), null, {
        url: `https://t.me/${botUsername}?startgroup=add`
      })),
      row(
        btn(ctx.i18n.t('menu.start.btn.help'), cb(help.SCREEN_ID, 'tab', 'start', String(ctx.from.id))),
        btn(ctx.i18n.t('menu.start.btn.lang'), cb(langPicker.SCREEN_ID, 'open'))
      )
    ]
  }
}

// Group chats get a 1-line hint and a single inline help button. Deep-links
// never fire in group context (Telegram only passes them from the user's
// private-chat `?start=…` flow), so we skip that logic here entirely.
const buildGroupKeyboard = (ctx) => ({
  inline_keyboard: [
    row(btn(ctx.i18n.t('menu.start.btn.help'), cb(help.SCREEN_ID, 'tab', 'start', String(ctx.from.id))))
  ]
})

const sendPrivateCard = async (ctx) => {
  const text = ctx.i18n.t('menu.start.private', { name: userName(ctx.from) })
  await replyHTML(ctx, text, { reply_markup: buildPrivateKeyboard(ctx) })
}

const sendGroupHint = async (ctx) => {
  await replyHTML(ctx, ctx.i18n.t('menu.start.group'), {
    reply_markup: buildGroupKeyboard(ctx),
    reply_to_message_id: ctx.message && ctx.message.message_id
  })
}

const sendPlaceholder = async (ctx) => {
  await replyHTML(ctx, ctx.i18n.t('menu.start.placeholder'))
}

// /start mod_event_<eventId> — open expanded mod-event details in PM.
// Triggered when a chat member taps [🤨 За що?] on a group mod-event
// notification. Expanded text + admin-only [↩️ Розблокувати] (when the
// clicker is admin in the original chat).
const renderModEventInPm = async (ctx, eventId) => {
  if (!ctx.db || !ctx.db.ModEvent) return false
  const event = await modEvent.getModEvent(ctx.db, eventId)
  if (!event) return false

  const targetUser = {
    id: event.targetId,
    first_name: event.targetName || '',
    username: null
  }
  const expanded = modEvent.buildExpandedText(ctx.i18n, event, targetUser)
  const isAdmin = await isUserAdmin(ctx.telegram, event.chatId, ctx.from.id)
  const inline = []
  if (isAdmin && (event.actionType === 'auto_ban' || event.actionType === 'auto_mute' || event.actionType === 'global_ban')) {
    inline.push([{ text: ctx.i18n.t('mod_event.btn.undo'), callback_data: `m:v1:mod.event:undo:${eventId}` }])
  }
  await replyHTML(ctx, expanded, inline.length ? { reply_markup: { inline_keyboard: inline } } : {})
  return true
}

module.exports = async (ctx) => {
  const isPrivate = ctx.chat && ctx.chat.type === 'private'

  if (!isPrivate) {
    return sendGroupHint(ctx)
  }

  const parsed = parseStartPayload(readPayload(ctx))

  if (parsed.kind === 'help') {
    return help.sendHelp(ctx, ctx.from.id)
  }

  if (parsed.kind === 'settings') {
    const settingsRoot = getMenu('settings.root')
    if (!settingsRoot) {
      return sendPlaceholder(ctx)
    }
    // Resolve the target group, check admin status in that group, then render
    // the root panel into the private chat. The render function builds from
    // ctx.group.info.settings — we swap in the target group's data before
    // calling it.
    try {
      if (!ctx.db) return sendPlaceholder(ctx)
      const groupDoc = await ctx.db.Group.findOne({ group_id: parsed.chatId })
      if (!groupDoc) return sendPlaceholder(ctx)

      // Admin check against the target group.
      let member
      try {
        member = await ctx.telegram.getChatMember(parsed.chatId, ctx.from.id)
      } catch (e) {
        return sendPlaceholder(ctx)
      }
      if (!member || !['creator', 'administrator'].includes(member.status)) {
        return sendPlaceholder(ctx)
      }

      // Remember target group for subsequent menu callbacks in this DM.
      // Without this, every settings.* button click would fail group_admin
      // checks because ctx.chat in PM doesn't reflect the user's group role.
      setPmTarget(ctx.from.id, parsed.chatId)
      setKnownAdmin(parsed.chatId, ctx.from.id, true)

      // Swap group context so renderRoot reads from the target group's settings.
      const prevGroup = ctx.group
      ctx.group = { info: groupDoc }
      ctx.targetChatId = parsed.chatId
      try {
        const view = await settingsRoot.render(ctx, { targetChatId: parsed.chatId })
        if (view && view.text) {
          await replyHTML(ctx, view.text, view.keyboard ? { reply_markup: view.keyboard } : {})
        }
      } finally {
        ctx.group = prevGroup
      }
    } catch (err) {
      log.warn({ err: err && err.message }, '/start settings deep-link failed')
      await sendPlaceholder(ctx)
    }
    return
  }

  if (parsed.kind === 'mod_event') {
    try {
      const ok = await renderModEventInPm(ctx, parsed.eventId)
      if (ok) return
    } catch (err) {
      log.warn({ err: err && err.message }, '/start mod_event deep-link failed')
    }
    return sendPlaceholder(ctx)
  }

  if (parsed.kind === 'mystats') {
    // /mystats deep-link — resolve the target Group + GroupMember and render
    // the panel directly in the DM. Falls back to placeholder if the bot
    // doesn't know the chat or the user never posted in it.
    try {
      if (typeof myStats.handleDeepLink === 'function') {
        const ok = await myStats.handleDeepLink(ctx, parsed.chatId)
        if (ok) return
      }
    } catch (err) {
      log.warn({ err: err && err.message }, '/start mystats deep-link failed')
    }
    return sendPlaceholder(ctx)
  }

  // Unknown payload or none: plain welcome.
  return sendPrivateCard(ctx)
}

module.exports.parseStartPayload = parseStartPayload
module.exports.readPayload = readPayload
