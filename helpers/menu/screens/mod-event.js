// Callback handler for compact-by-default moderation notifications (§9 of
// the UX design). Callback shape: `m:v1:mod.event:<action>:<eventId>`.
//
// Actions:
//   why    — expand: show confidence + reason + preview. Any chat member.
//   less   — collapse back to one-liner. Any chat member.
//   hide   — admin-only: delete the notification message entirely.
//   undo   — admin-only: attempt unban / unmute; on success replace message
//            with an `override` line + 30s auto-delete.
//   rights — no-op for now: surface a toast pointing at /help admin tab.
//            The button remains here so future Plan 6 ("as dat prava")
//            work can wire the real inline instruction without touching
//            the send-site.
//
// Voting events (actionType='voting') are rendered by this screen for
// compact/expanded chrome but their [🚫]/[✅] vote buttons still use the
// legacy `sv:*` callback_data and are handled in handlers/spam-vote.js.
//
// Access: 'public' at the router level — the screen itself gates hide/undo
// by calling `isAdmin(ctx)` inside handle(). Splitting would need two
// screens sharing the same eventId shape; less surface to keep the guard
// inline here.

const { registerMenu } = require('../registry')
const { isAdmin } = require('../access')
const { editHTML } = require('../../reply-html')
const modEvent = require('../../mod-event')
const { logModEvent } = require('../../mod-log')
const policy = require('../../cleanup-policy')
const { scheduleDeletion } = require('../../message-cleanup')
const { bot: log } = require('../../logger')

const SCREEN_ID = 'mod.event'

// Refresh auto-delete for the compact/expanded/override TTL windows.
// We reschedule whenever the view changes so an actively-clicked event
// lives the expected amount of time after each interaction.
const refreshDeletion = (ctx, messageId, actionType, nextView) => {
  if (!ctx.db || !ctx.chat) return Promise.resolve()
  const delayMs = nextView === 'override'
    ? policy.mod_event_override
    : nextView === 'expanded'
      ? policy.mod_event_expanded
      : policy.mod_event_compact
  return scheduleDeletion(ctx.db, {
    chatId: ctx.chat.id,
    messageId,
    delayMs,
    source: `mod_event:${actionType || 'unknown'}:${nextView}`
  }, ctx.telegram).catch(() => {})
}

const buildTarget = (event) => ({
  id: event.targetId,
  first_name: event.targetName,
  username: event.targetUsername,
  title: event.targetTitle,
  isChannel: event.isChannel
})

const renderCompact = async (ctx, event) => {
  const target = buildTarget(event)
  const { text } = modEvent.buildCompactText(ctx.i18n, event, target)
  const keyboard = modEvent.buildCompactKeyboard(ctx.i18n, event)
  await editHTML(ctx, ctx.callbackQuery.message.message_id, text, {
    reply_markup: keyboard
  })
  await refreshDeletion(ctx, ctx.callbackQuery.message.message_id, event.actionType, 'compact')
}

const renderExpanded = async (ctx, event, viewerIsAdmin) => {
  const target = buildTarget(event)
  const text = modEvent.buildExpandedText(ctx.i18n, event, target)
  const keyboard = modEvent.buildExpandedKeyboard(ctx.i18n, event, { isAdmin: viewerIsAdmin })
  await editHTML(ctx, ctx.callbackQuery.message.message_id, text, {
    reply_markup: keyboard
  })
  await refreshDeletion(ctx, ctx.callbackQuery.message.message_id, event.actionType, 'expanded')
}

// Try both unban/unmute paths regardless of the recorded action type —
// idempotent, mirrors handlers/spam-vote.js handleAdminOverride logic.
const tryUndo = async (ctx, event) => {
  const chatId = event.chatId
  const targetId = event.targetId
  if (!targetId) return { ok: false, err: 'no_target' }

  try {
    if (targetId > 0) {
      await ctx.telegram.callApi('unbanChatMember', {
        chat_id: chatId,
        user_id: targetId,
        only_if_banned: true
      }).catch(() => {})
      await ctx.telegram.restrictChatMember(chatId, targetId, {
        permissions: {
          can_send_messages: true,
          can_send_audios: true,
          can_send_documents: true,
          can_send_photos: true,
          can_send_videos: true,
          can_send_video_notes: true,
          can_send_voice_notes: true,
          can_send_polls: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
          can_change_info: false,
          can_invite_users: true,
          can_pin_messages: false,
          can_manage_topics: false
        }
      }).catch(() => {})
    } else {
      await ctx.telegram.callApi('unbanChatSenderChat', {
        chat_id: chatId,
        sender_chat_id: targetId
      }).catch(() => {})
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, err: err.message }
  }
}

const handle = async (ctx, action, args) => {
  const eventId = args && args[0]
  if (!eventId) {
    return { render: false, toast: 'mod_event.toast.not_found' }
  }

  const event = await modEvent.getModEvent(ctx.db, eventId)
  if (!event) {
    return { render: false, toast: 'mod_event.toast.not_found' }
  }

  if (action === 'why') {
    const viewerIsAdmin = await isAdmin(ctx)
    try {
      await renderExpanded(ctx, event, viewerIsAdmin)
    } catch (err) {
      if (!/message is not modified/.test(err.message || '')) {
        log.warn({ err: err.message, eventId }, 'mod.event why: render failed')
      }
    }
    return { render: false, silent: true }
  }

  if (action === 'less') {
    try {
      await renderCompact(ctx, event)
    } catch (err) {
      if (!/message is not modified/.test(err.message || '')) {
        log.warn({ err: err.message, eventId }, 'mod.event less: render failed')
      }
    }
    return { render: false, silent: true }
  }

  if (action === 'hide') {
    const viewerIsAdmin = await isAdmin(ctx)
    if (!viewerIsAdmin) {
      return { render: false, toast: 'menu.access.only_admins' }
    }
    try {
      await ctx.deleteMessage()
    } catch { /* ignore — message may be gone already */ }
    return { render: false, toast: 'mod_event.toast.hidden' }
  }

  if (action === 'undo') {
    const viewerIsAdmin = await isAdmin(ctx)
    if (!viewerIsAdmin) {
      return { render: false, toast: 'menu.access.only_admins' }
    }
    const result = await tryUndo(ctx, event)
    if (!result.ok) {
      log.warn({ err: result.err, eventId }, 'mod.event undo: failed')
      return { render: false, toast: 'mod_event.toast.undo_failed' }
    }
    // Flip the event into override state + rerender.
    const adminName = ctx.from && (ctx.from.first_name || ctx.from.username)
      ? (ctx.from.first_name || ctx.from.username)
      : String(ctx.from && ctx.from.id)
    const updated = await modEvent.updateModEvent(ctx.db, eventId, {
      actionType: 'override',
      actorId: ctx.from && ctx.from.id,
      actorName: adminName
    })
    const overrideEvent = updated || { ...event.toObject(), actionType: 'override', actorId: ctx.from && ctx.from.id, actorName: adminName }
    // Audit the override in ModLog; reason carries the original eventId so
    // the journal can cross-reference the undone action.
    logModEvent(ctx.db, {
      chatId: event.chatId,
      eventType: 'override',
      actor: ctx.from,
      target: {
        id: event.targetId,
        name: event.targetName || event.targetUsername || null
      },
      action: `undo ${event.actionType}`,
      reason: `eventId=${eventId}`
    }).catch(() => {})
    const { text } = modEvent.buildCompactText(ctx.i18n, overrideEvent, buildTarget(overrideEvent))
    try {
      await editHTML(ctx, ctx.callbackQuery.message.message_id, text, {
        reply_markup: { inline_keyboard: [] }
      })
    } catch (err) {
      if (!/message is not modified/.test(err.message || '')) {
        log.warn({ err: err.message, eventId }, 'mod.event undo: render failed')
      }
    }
    await refreshDeletion(ctx, ctx.callbackQuery.message.message_id, 'override', 'override')
    return { render: false, toast: 'mod_event.toast.undone' }
  }

  if (action === 'rights') {
    // Placeholder: point admins at /help (admin tab) via a toast. Plan 6
    // will wire the full inline instruction.
    return { render: false, toast: 'mod_event.btn.give_rights' }
  }

  return { render: false, silent: true }
}

const register = () => {
  registerMenu({
    id: SCREEN_ID,
    // Router-level access is the lowest bar. hide/undo/rights enforce
    // admin-only internally in `handle()` above.
    access: 'public',
    // Nothing to render fresh: the message already exists; we only react
    // to actions. Router only calls render() when action === 'open', which
    // is never the case for mod.event.
    render: () => ({ text: '' }),
    handle
  })
}

module.exports = {
  register,
  SCREEN_ID,
  renderCompact,
  renderExpanded,
  handle,
  tryUndo
}
