// The single entry point the rest of the codebase calls to send a
// compact-by-default moderation notification (§9 of the UX design).
//
// Replaces the ad-hoc `spam.notification.*`, `global_ban.kicked`,
// `report.spam_found` replyWithHTML calls that used to each render a
// different full-card format.
//
// One message is sent; the callback handler (helpers/menu/screens/mod-event.js)
// re-renders it on `[🤨 За що?]` / `[🛡 Зменшити]`.
//
// We CANNOT hide [✓ Сховати] per-viewer (Telegram sends one inline-keyboard
// per message to every chat member) — the callback handler enforces the
// admin-only semantics by rejecting non-admin clicks with a localized toast.

const modEvent = require('./mod-event')
const { logModEvent } = require('./mod-log')
const { replyHTML } = require('./reply-html')
const { scheduleDeletion } = require('./message-cleanup')
const policy = require('./cleanup-policy')
const { notification: log } = require('./logger')

// Map ModEvent.actionType → ModLog.eventType. ModLog is the audit trail; not
// every actionType is auditable (override is written explicitly from the
// undo handler; voting resolves into a separate vote_resolved row).
const MOD_LOG_TYPE_BY_ACTION = {
  auto_ban: 'auto_ban',
  auto_mute: 'auto_mute',
  auto_delete: 'auto_del'
}

// Mutate the inline keyboard to swap any [🤨 За що?] callback button for
// a t.me deep-link URL button. Group viewers tap → bot DM opens with
// /start mod_event_<eventId>; expanded view + admin actions render in PM.
// Falls back silently if botUsername is unknown (keeps callback button).
const rewireWhyToPm = (keyboard, eventId, botUsername) => {
  if (!botUsername || !keyboard || !Array.isArray(keyboard.inline_keyboard)) return
  const url = `https://t.me/${botUsername}?start=mod_event_${eventId}`
  for (const row of keyboard.inline_keyboard) {
    for (let i = 0; i < row.length; i++) {
      const cb = row[i] && row[i].callback_data
      if (typeof cb === 'string' && cb.startsWith('m:v1:mod.event:why:')) {
        row[i] = { text: row[i].text, url }
      }
    }
  }
}

/**
 * @param {Object} ctx — Telegraf context (must have ctx.telegram, ctx.chat,
 *                       ctx.db, ctx.i18n).
 * @param {Object} opts
 * @param {string} opts.actionType — one of ModEvent.ACTION_TYPES.
 * @param {Object} opts.targetUser  — { id, first_name, username, title? }
 * @param {'bot'|Object} [opts.actor] — 'bot' or { id, first_name, username }.
 * @param {string}  [opts.reason]    — short code; looked up in mod_event.reason.*.
 * @param {number}  [opts.confidence]
 * @param {string}  [opts.messagePreview]
 * @param {string}  [opts.warning]
 * @returns {Promise<{event, sentMessageId}|null>}
 */
const sendModEventNotification = async (ctx, opts = {}) => {
  const {
    actionType,
    targetUser = {},
    actor = 'bot',
    reason,
    confidence: rawConfidence,
    messagePreview,
    warning
  } = opts
  // Normalize to integer once at the entry point so both ModEvent.confidence
  // and the `confidence=NN` string on ModLog.reason stay clean for analytics.
  const confidence = modEvent.roundConfidence(rawConfidence)

  if (!ctx || !ctx.telegram || !ctx.chat || !ctx.db || !ctx.db.ModEvent) {
    log.warn({ actionType }, 'mod-event-send: missing ctx plumbing — skipping notification')
    return null
  }

  const actorId = (actor && actor !== 'bot') ? actor.id : 0
  const actorName = (actor && actor !== 'bot') ? (actor.first_name || actor.username) : null

  let event
  try {
    event = await modEvent.createModEvent(ctx.db, {
      chatId: ctx.chat.id,
      actorId,
      actorName,
      targetId: targetUser.id,
      targetName: targetUser.first_name,
      targetUsername: targetUser.username,
      targetTitle: targetUser.title,
      isChannel: Boolean(targetUser.isChannel || targetUser.title),
      actionType,
      reason,
      confidence,
      messagePreview: messagePreview ? String(messagePreview).slice(0, 200) : undefined,
      warning
    })
  } catch (err) {
    log.error({ err, actionType }, 'mod-event-send: failed to create event row')
    return null
  }

  // Audit automatic actions into ModLog (parallel to the ephemeral ModEvent).
  // Decoupled TTLs: ModEvent = 7d UI state, ModLog = 30d queryable history.
  const logType = MOD_LOG_TYPE_BY_ACTION[actionType]
  if (logType) {
    logModEvent(ctx.db, {
      chatId: ctx.chat.id,
      eventType: logType,
      actor: (actor && actor !== 'bot') ? actor : null,
      target: targetUser,
      action: reason || '',
      reason: confidence !== undefined ? `confidence=${confidence}` : null
    }).catch(() => {})
  }

  const { text } = modEvent.buildCompactText(ctx.i18n, event, targetUser)
  const keyboard = modEvent.buildCompactKeyboard(ctx.i18n, event)
  // Swap [🤨 За що?] callback for a t.me deep-link URL button — expand
  // in PM, not in-group. Keeps group chrome minimal; the PM-side view has
  // membership gating (handlers/start.js) + admin-only undo.
  rewireWhyToPm(keyboard, event.eventId, ctx.botInfo && ctx.botInfo.username)

  let sent
  try {
    sent = await replyHTML(ctx, text, { reply_markup: keyboard })
  } catch (err) {
    log.error({ err, actionType }, 'mod-event-send: failed to send notification')
    // Best-effort: leave the DB row behind; TTL will collect it.
    return { event, sentMessageId: null }
  }

  if (sent && sent.message_id) {
    // Persist the (chatId, messageId) on the event so the callback handler
    // can look up the right message to edit / delete without guessing from
    // ctx.callbackQuery.message alone.
    try {
      await modEvent.updateModEvent(ctx.db, event.eventId, {
        notificationChatId: ctx.chat.id,
        notificationMessageId: sent.message_id
      })
    } catch (err) {
      log.warn({ err, eventId: event.eventId }, 'mod-event-send: failed to patch event with message_id')
    }

    // Schedule compact-default auto-delete. The callback handler reschedules
    // with the expanded / override TTL when the view changes.
    const delayMs = actionType === 'override'
      ? policy.mod_event_override
      : policy.mod_event_compact
    try {
      await scheduleDeletion(ctx.db, {
        chatId: ctx.chat.id,
        messageId: sent.message_id,
        delayMs,
        source: `mod_event:${actionType}`
      }, ctx.telegram)
    } catch (err) {
      log.warn({ err, eventId: event.eventId }, 'mod-event-send: scheduleDeletion failed')
    }
  }

  return { event, sentMessageId: sent && sent.message_id }
}

module.exports = { sendModEventNotification }
