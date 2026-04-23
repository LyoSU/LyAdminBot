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
const { getMenu } = require('../helpers/menu/registry')
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
        btn(ctx.i18n.t('menu.start.btn.lang'), 'set_language:uk')
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

      // Swap group context so renderRoot reads from the target group's settings.
      const prevGroup = ctx.group
      ctx.group = { info: groupDoc }
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

  if (parsed.kind === 'mystats') {
    // Forward to the existing /mystats handler. /mystats requires a group
    // context (ctx.group, member data). In the private-chat deep-link case
    // we don't have that yet — punt to the placeholder. Wiring the full
    // "resolve group by id, load member stats, send stats" path is Plan 8
    // territory; this branch is scaffolding.
    return sendPlaceholder(ctx)
  }

  // Unknown payload or none: plain welcome.
  return sendPrivateCard(ctx)
}

module.exports.parseStartPayload = parseStartPayload
module.exports.readPayload = readPayload
