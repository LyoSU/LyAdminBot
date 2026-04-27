// /banan quick-picker (§6 of the UX design).
//
// Posted by handlers/banan.js when an admin calls `/banan` as a reply
// WITHOUT a duration argument. The picker lives 30 seconds
// (cleanup_policy.quick_picker); any admin in the chat can pick a
// duration. Picking calls into the shared performBan() helper in
// handlers/banan.js and emits the unified mod-event result with the
// [↩️ Скасувати] button.
//
// Callback shape:
//   m:v1:mod.ban.picker:do:<targetId>:<seconds>   → ban for N seconds
//   m:v1:mod.ban.picker:do:<targetId>:0           → ban permanently
//   m:v1:_close                                   → cancel (router-handled)
//
// Access: group_admin. The initiator is the admin who typed /banan, but
// the spec explicitly allows any other admin to click — the simpler
// `group_admin` rule covers that without needing to smuggle the
// initiator id through menuState.

const { registerMenu } = require('../registry')
const { cb, btn, row, CLOSE } = require('../keyboard')
const { scheduleDeletion } = require('../../message-cleanup')
const policy = require('../../cleanup-policy')
const { bot: log } = require('../../logger')

const SCREEN_ID = 'mod.ban.picker'

// Duration buttons in seconds. `0` is reserved for permanent. Keep these
// short so the callback_data stays under 64 bytes even with large
// negative group chat ids.
const DURATIONS = [
  { label: '5 хв', seconds: 5 * 60, localeKey: 'menu.mod.ban.picker.dur_5m' },
  { label: '30 хв', seconds: 30 * 60, localeKey: 'menu.mod.ban.picker.dur_30m' },
  { label: '1 год', seconds: 60 * 60, localeKey: 'menu.mod.ban.picker.dur_1h' },
  { label: '6 год', seconds: 6 * 60 * 60, localeKey: 'menu.mod.ban.picker.dur_6h' },
  { label: '1 день', seconds: 24 * 60 * 60, localeKey: 'menu.mod.ban.picker.dur_1d' },
  { label: '7 днів', seconds: 7 * 24 * 60 * 60, localeKey: 'menu.mod.ban.picker.dur_7d' }
]

const buildKeyboard = (ctx, targetId) => {
  const durationRow1 = row(
    ...DURATIONS.slice(0, 3).map(d => btn(
      ctx.i18n.t(d.localeKey),
      cb(SCREEN_ID, 'do', targetId, d.seconds)
    ))
  )
  const durationRow2 = row(
    ...DURATIONS.slice(3, 6).map(d => btn(
      ctx.i18n.t(d.localeKey),
      cb(SCREEN_ID, 'do', targetId, d.seconds)
    ))
  )
  const foreverRow = row(btn(
    ctx.i18n.t('menu.mod.ban.picker.dur_forever'),
    cb(SCREEN_ID, 'do', targetId, 0)
  ))
  const cancelRow = row(btn(ctx.i18n.t('menu.mod.ban.picker.cancel'), CLOSE))
  return { inline_keyboard: [durationRow1, durationRow2, foreverRow, cancelRow] }
}

const renderPicker = (ctx, { targetName, targetId }) => {
  const text = ctx.i18n.t('menu.mod.ban.picker.text', { name: targetName })
  const keyboard = buildKeyboard(ctx, targetId)
  return { text, keyboard }
}

// Refresh the auto-delete timer when the admin clicks (but doesn't pick
// a duration — currently only possible via cancel, which short-circuits
// via the reserved _close token). Left as a helper in case future UX
// adds a "preview target" sub-action that should re-arm the timer.
const refreshTimer = (ctx, messageId) => {
  if (!ctx.db || !ctx.chat) return Promise.resolve()
  return scheduleDeletion(ctx.db, {
    chatId: ctx.chat.id,
    messageId,
    delayMs: policy.quick_picker,
    source: 'mod_ban_picker'
  }, ctx.telegram).catch(() => {})
}

// `handle` is called by the menu router for any `mod.ban.picker:*`
// callback. Only action we support is `do:<targetId>:<seconds>`.
const handle = async (ctx, action, args) => {
  if (action !== 'do') {
    return { render: false, silent: true }
  }
  const targetId = parseInt(args[0], 10)
  const seconds = parseInt(args[1], 10)
  if (!Number.isFinite(targetId) || !Number.isFinite(seconds) || seconds < 0) {
    return { render: false, toast: 'menu.mod.ban.picker.invalid' }
  }

  // Lazy-require to avoid a cycle (banan.js imports menu helpers for the
  // send-picker side). By the time a callback fires, handlers/banan.js
  // has been loaded at least once already.
  const banan = require('../../../handlers/banan')
  if (typeof banan.performBan !== 'function') {
    log.warn('mod.ban.picker: handlers/banan.js missing performBan export')
    return { render: false, toast: 'menu.mod.ban.picker.invalid' }
  }

  try {
    const result = await banan.performBan(ctx, {
      targetId,
      seconds,
      adminUser: ctx.from,
      deletePickerMessageId: ctx.callbackQuery.message && ctx.callbackQuery.message.message_id
    })
    if (!result || !result.ok) {
      return { render: false, toast: result && result.toastKey ? result.toastKey : 'menu.mod.ban.picker.failed' }
    }
  } catch (err) {
    log.warn({ err }, 'mod.ban.picker: performBan threw')
    return { render: false, toast: 'menu.mod.ban.picker.failed' }
  }

  // Message is already deleted inside performBan; nothing more to render.
  return { render: false, silent: true }
}

const register = () => {
  registerMenu({
    id: SCREEN_ID,
    access: 'group_admin',
    render: () => ({ text: '' }),
    handle
  })
}

module.exports = {
  register,
  SCREEN_ID,
  DURATIONS,
  buildKeyboard,
  renderPicker,
  refreshTimer,
  handle
}
