// /help screen — single message with five tabs (start, mod, stats, admin,
// about). Root opens on `start`. Only the command initiator can click tabs;
// others get a localized toast.
//
// State: the clicker's access is validated by embedding the initiator's
// user_id as the 2nd callback arg (after the section). Avoids persisting
// initiator state anywhere — the button itself carries proof. Cheap and
// survives bot restarts trivially.
//
// Auto-delete: bumped on every click via scheduleDeletion with TTL
// cleanup_policy.cmd_help. In private chats (non-group), the initiator
// access collapses to trivial self-authorship and auto-delete is skipped
// (no chat-noise pressure).

const { registerMenu } = require('../registry')
const { cb, btn, row } = require('../keyboard')
const { replyHTML } = require('../../reply-html')
const { scheduleDeletion } = require('../../message-cleanup')
const policy = require('../../cleanup-policy')
const { bot: log } = require('../../logger')

const SCREEN_ID = 'help.root'
const TABS = ['start', 'mod', 'stats', 'admin', 'about']
const DEFAULT_TAB = 'start'

// Build tab-row keyboard. Active tab is prefixed with `●`. Callback carries
// `<section>:<initiatorId>` — section picks the new tab; initiatorId proves
// click authorization.
const buildKeyboard = (activeTab, initiatorId) => {
  const mk = (tabId) => {
    const label = `${tabId === activeTab ? '● ' : ''}` + (LABELS[tabId] || tabId)
    return btn(label, cb(SCREEN_ID, 'tab', tabId, String(initiatorId)))
  }
  // 3 + 2 layout per spec §3
  return {
    inline_keyboard: [
      row(mk('start'), mk('mod'), mk('stats')),
      row(mk('admin'), mk('about'))
    ]
  }
}

// Placeholder labels — actual text comes from i18n at render time.
// Kept here only so buildKeyboard can be exercised in isolation in tests.
const LABELS = {
  start: '🛡 Старт',
  mod: '⚔️ Модерація',
  stats: '📊 Стата',
  admin: '🔧 Адмін',
  about: '💬 Про бота'
}

const getI18nLabels = (ctx) => {
  const t = (k) => ctx.i18n.t('menu.help.tab_label.' + k)
  return { start: t('start'), mod: t('mod'), stats: t('stats'), admin: t('admin'), about: t('about') }
}

const buildKeyboardI18n = (ctx, activeTab, initiatorId) => {
  const labels = getI18nLabels(ctx)
  const mk = (tabId) => btn(
    (tabId === activeTab ? '● ' : '') + labels[tabId],
    cb(SCREEN_ID, 'tab', tabId, String(initiatorId))
  )
  return {
    inline_keyboard: [
      row(mk('start'), mk('mod'), mk('stats')),
      row(mk('admin'), mk('about'))
    ]
  }
}

// Compose the help message body for a given tab.
// Shape: title + blank line + tab body.
const renderText = (ctx, tab) => {
  const title = ctx.i18n.t('menu.help.title')
  const body = ctx.i18n.t('menu.help.body.' + tab)
  return `${title}\n\n${body}`
}

const refreshDeletion = (ctx, messageId) => {
  if (!ctx.db || !ctx.chat || ctx.chat.type === 'private') return
  scheduleDeletion(ctx.db, {
    chatId: ctx.chat.id,
    messageId,
    delayMs: policy.cmd_help,
    source: 'cmd_help'
  }, ctx.telegram).catch(() => {})
}

// Entry point when user runs /help (or deep-link `?start=help`). Sends a
// fresh message with the default tab, then schedules cleanup.
const sendHelp = async (ctx, initiatorId) => {
  const text = renderText(ctx, DEFAULT_TAB)
  const keyboard = buildKeyboardI18n(ctx, DEFAULT_TAB, initiatorId)
  try {
    const message = await replyHTML(ctx, text, {
      reply_markup: keyboard,
      reply_to_message_id: ctx.message && ctx.message.message_id
    })
    if (message && message.message_id) {
      refreshDeletion(ctx, message.message_id)
      // Also delete the user's /help command after TTL (keeps group clean)
      if (ctx.message && ctx.message.message_id && ctx.db &&
        ['supergroup', 'group'].includes(ctx.chat.type)) {
        scheduleDeletion(ctx.db, {
          chatId: ctx.chat.id,
          messageId: ctx.message.message_id,
          delayMs: policy.cmd_help,
          source: 'cmd_help'
        }, ctx.telegram).catch(() => {})
      }
    }
    return message
  } catch (err) {
    log.warn({ err }, '/help send failed')
    return null
  }
}

const register = () => {
  registerMenu({
    id: SCREEN_ID,
    access: 'initiator',
    // Extract initiator from the callback payload's last arg. That arg was
    // baked into the button at render time; the router validates it matches
    // ctx.from.id. Keeps us from needing per-message persistence.
    accessOpts: (ctx) => {
      const data = ctx.callbackQuery && ctx.callbackQuery.data
      if (!data) return {}
      const parts = data.split(':')
      // data = m:v1:help.root:tab:<section>:<initiatorId>
      const last = parts[parts.length - 1]
      const initiatorId = parseInt(last, 10)
      if (!Number.isFinite(initiatorId)) return {}
      return { initiatorId }
    },
    render: (ctx, state) => {
      const tab = (state && state.tab) || DEFAULT_TAB
      const initiatorId = (state && state.initiatorId) || (ctx.from && ctx.from.id) || 0
      return {
        text: renderText(ctx, tab),
        keyboard: buildKeyboardI18n(ctx, tab, initiatorId)
      }
    },
    handle: async (ctx, action, args) => {
      if (action === 'tab') {
        const section = args[0]
        const initiatorId = parseInt(args[1], 10) || (ctx.from && ctx.from.id) || 0
        if (!TABS.includes(section)) {
          return { render: false }
        }
        // Refresh auto-delete on every click so an active user keeps the menu alive.
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
          refreshDeletion(ctx, ctx.callbackQuery.message.message_id)
        }
        return { render: true, state: { tab: section, initiatorId } }
      }
      return { render: false }
    }
  })
}

module.exports = {
  register,
  sendHelp,
  SCREEN_ID,
  TABS,
  DEFAULT_TAB,
  // exported for tests
  buildKeyboard,
  buildKeyboardI18n,
  renderText
}
