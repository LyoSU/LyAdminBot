// /del undo (§7 of the UX design).
//
// Posted by handlers/delete.js after successful deletion. Admin-only
// `[↩️ Відновити]` button re-sends the captured content from the bot
// with a "відновлено адміном" header. The notification self-deletes
// after 60s (cleanup_policy.banan_undo) regardless of click outcome.
//
// Callback:
//   m:v1:mod.del.undo:do:<chatId>:<messageId>  → restore from the LRU buffer
//
// Access: router-level 'public'; the handler rejects non-admin clicks
// with a toast (same pattern as mod.event — we can't hide inline buttons
// per-viewer).

const { registerMenu } = require('../registry')
const { isAdmin } = require('../access')
const { cb, btn, row, CLOSE, NOOP } = require('../keyboard')
const { replyHTML } = require('../../reply-html')
const { scheduleDeletion } = require('../../message-cleanup')
const policy = require('../../cleanup-policy')
const buffer = require('../../delete-buffer')
const { bot: log } = require('../../logger')

const SCREEN_ID = 'mod.del.undo'

const buildNotificationText = (ctx) => ctx.i18n.t('menu.mod.del.undo.notification')

const buildNotificationKeyboard = (ctx, { chatId, messageId, restorable }) => {
  const rows = []
  if (restorable) {
    rows.push(row(btn(
      ctx.i18n.t('menu.mod.del.undo.btn.restore'),
      cb(SCREEN_ID, 'do', chatId, messageId)
    )))
  } else {
    // Include a disabled-looking button so the admin sees why there's no undo.
    rows.push(row(btn(
      ctx.i18n.t('menu.mod.del.undo.btn.cant_restore'),
      NOOP
    )))
  }
  rows.push(row(btn(ctx.i18n.t('menu.common.dismiss'), CLOSE)))
  return { inline_keyboard: rows }
}

/**
 * Post the `[↩️ Відновити]` notification after a successful /del.
 */
const sendUndoNotification = async (ctx, { chatId, messageId }) => {
  const rec = buffer.get(chatId, messageId)
  const restorable = buffer.isRestorable(rec)
  const text = buildNotificationText(ctx)
  const keyboard = buildNotificationKeyboard(ctx, { chatId, messageId, restorable })

  let sent
  try {
    sent = await replyHTML(ctx, text, { reply_markup: keyboard })
  } catch (_err) {
    return null
  }
  if (sent && sent.message_id && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: sent.message_id,
      delayMs: policy.banan_undo,
      source: 'mod_del_undo'
    }, ctx.telegram).catch(() => {})
  }
  return sent
}

/**
 * Resend the captured content from the bot. Prefix with a small HTML
 * note crediting the admin who clicked. Returns true on success.
 */
const restore = async (ctx, rec, adminUser) => {
  if (!rec) return false
  const who = adminUser && (adminUser.username
    ? `@${adminUser.username}`
    : (adminUser.first_name || String(adminUser.id)))
  const header = ctx.i18n.t('menu.mod.del.undo.restored_by', { admin: who })

  // Plain text / caption path (HTML parse_mode mirrors the legacy
  // /del behaviour — entities are dropped, but the odds of sensitive
  // formatting in a message that was spam-flagged are low).
  const tg = ctx.telegram

  try {
    if (rec.photoFileId) {
      await tg.callApi('sendPhoto', {
        chat_id: ctx.chat.id,
        photo: rec.photoFileId,
        caption: `${header}${rec.caption ? '\n\n' + rec.caption : ''}`,
        parse_mode: 'HTML'
      })
      return true
    }
    if (rec.videoFileId) {
      await tg.callApi('sendVideo', {
        chat_id: ctx.chat.id,
        video: rec.videoFileId,
        caption: `${header}${rec.caption ? '\n\n' + rec.caption : ''}`,
        parse_mode: 'HTML'
      })
      return true
    }
    if (rec.animationFileId) {
      await tg.callApi('sendAnimation', {
        chat_id: ctx.chat.id,
        animation: rec.animationFileId,
        caption: `${header}${rec.caption ? '\n\n' + rec.caption : ''}`,
        parse_mode: 'HTML'
      })
      return true
    }
    if (rec.documentFileId) {
      await tg.callApi('sendDocument', {
        chat_id: ctx.chat.id,
        document: rec.documentFileId,
        caption: `${header}${rec.caption ? '\n\n' + rec.caption : ''}`,
        parse_mode: 'HTML'
      })
      return true
    }
    if (rec.voiceFileId) {
      await tg.callApi('sendVoice', {
        chat_id: ctx.chat.id,
        voice: rec.voiceFileId,
        caption: header,
        parse_mode: 'HTML'
      })
      return true
    }
    if (rec.audioFileId) {
      await tg.callApi('sendAudio', {
        chat_id: ctx.chat.id,
        audio: rec.audioFileId,
        caption: header,
        parse_mode: 'HTML'
      })
      return true
    }
    if (rec.stickerFileId) {
      // Stickers don't support captions — send the header separately.
      await replyHTML(ctx, header)
      await tg.callApi('sendSticker', {
        chat_id: ctx.chat.id,
        sticker: rec.stickerFileId
      })
      return true
    }
    if (rec.videoNoteFileId) {
      await replyHTML(ctx, header)
      await tg.callApi('sendVideoNote', {
        chat_id: ctx.chat.id,
        video_note: rec.videoNoteFileId
      })
      return true
    }
    if (rec.text) {
      await replyHTML(ctx, `${header}\n\n${rec.text}`)
      return true
    }
    return false
  } catch (err) {
    log.warn({ err: err.message }, 'mod.del.undo: restore failed')
    return false
  }
}

const handle = async (ctx, action, args) => {
  if (action !== 'do') return { render: false, silent: true }
  const viewerIsAdmin = await isAdmin(ctx)
  if (!viewerIsAdmin) {
    return { render: false, toast: 'menu.access.only_admins' }
  }

  const chatId = parseInt(args[0], 10)
  const messageId = parseInt(args[1], 10)
  if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) {
    return { render: false, toast: 'menu.mod.del.undo.toast.expired' }
  }

  const rec = buffer.get(chatId, messageId)
  if (!rec) {
    return { render: false, toast: 'menu.mod.del.undo.toast.expired' }
  }
  if (!buffer.isRestorable(rec)) {
    return { render: false, toast: 'menu.mod.del.undo.toast.cant_restore' }
  }

  const ok = await restore(ctx, rec, ctx.from)
  if (!ok) {
    return { render: false, toast: 'menu.mod.del.undo.toast.failed' }
  }
  // Consume the buffer entry — one undo per delete.
  buffer.del(chatId, messageId)
  // Delete the undo notification itself now that restore succeeded.
  try { await ctx.deleteMessage() } catch (_err) { /* ignore */ }
  return { render: false, toast: 'menu.mod.del.undo.toast.restored' }
}

const register = () => {
  registerMenu({
    id: SCREEN_ID,
    access: 'public',
    render: () => ({ text: '' }),
    handle
  })
}

module.exports = {
  register,
  SCREEN_ID,
  buildNotificationText,
  buildNotificationKeyboard,
  sendUndoNotification,
  restore,
  handle
}
