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
const adminCache = require('../../admin-cache')
const { applyAdminOverride } = require('../../admin-override')
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

// Post-result spam-vote actions (§10). Both branches:
//   1. Verify presser is admin (toast-reject otherwise).
//   2. Apply the action (perma-ban / 30d-ban).
//   3. Edit the existing notification: keep the result text, append a
//      "·{suffix}" marker, drop the keyboard.
//   4. Audit via ModLog.
// The setTimeout-based keyboard strip from vote-ui will fire harmlessly
// later — Telegram returns "message is not modified", which we ignore.
const handlePostVoteAction = async (ctx, action, eventId) => {
  const viewerIsAdmin = await isAdmin(ctx)
  if (!viewerIsAdmin) {
    return { render: false, toast: 'menu.access.only_admins' }
  }
  const spamVote = await findVoteByEventId(ctx, eventId)
  if (!spamVote || !spamVote.bannedUserId || !spamVote.chatId) {
    return { render: false, toast: 'spam_vote.cb.not_found' }
  }

  const adminName = (ctx.from && (ctx.from.first_name || ctx.from.username)) || String(ctx.from && ctx.from.id)
  const adminLabel = adminName

  if (action === 'perma') {
    // Permanent ban — banChatMember without `until_date`. Ignore failures
    // (user may already be banned). The keyboard is dropped either way.
    try {
      await ctx.telegram.callApi('banChatMember', {
        chat_id: spamVote.chatId,
        user_id: spamVote.bannedUserId
      })
    } catch (err) {
      log.warn({ err: err.message, eventId }, 'mod.event perma: ban failed')
      return { render: false, toast: 'mod_event.toast.undo_failed' }
    }

    // Append a perma-marker to the existing message text and strip kbd.
    const currentText = (ctx.callbackQuery.message && ctx.callbackQuery.message.text) || ''
    const suffix = ' · ' + ctx.i18n.t('spam_vote.post_result.perma_marker', { admin: adminLabel })
    const nextText = currentText.endsWith(suffix.trim()) ? currentText : currentText + suffix
    try {
      await editHTML(ctx, ctx.callbackQuery.message.message_id, nextText, {
        reply_markup: { inline_keyboard: [] }
      })
    } catch (err) {
      if (!/message is not modified/.test(err.message || '')) {
        log.warn({ err: err.message, eventId }, 'mod.event perma: edit failed')
      }
    }

    logModEvent(ctx.db, {
      chatId: spamVote.chatId,
      eventType: 'manual_ban',
      actor: ctx.from,
      target: { id: spamVote.bannedUserId, name: spamVote.bannedUserName || spamVote.bannedUserUsername || null },
      action: 'ban perma',
      reason: `eventId=${eventId} post_vote_perma`
    }).catch(() => {})

    return { render: false, toast: 'spam_vote.toast.perma_done' }
  }

  if (action === 'still_ban') {
    // 30-day ban over a clean-confirmed result. We use until_date 30d so
    // the user can still be unbanned later if they appeal.
    const untilDate = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
    try {
      await ctx.telegram.callApi('banChatMember', {
        chat_id: spamVote.chatId,
        user_id: spamVote.bannedUserId,
        until_date: untilDate
      })
    } catch (err) {
      log.warn({ err: err.message, eventId }, 'mod.event still_ban: ban failed')
      return { render: false, toast: 'mod_event.toast.undo_failed' }
    }

    // Replace text with a compact override line so it reads as a single
    // record. Spec wording: "🍌 {name} — забанено адміном @{x} (попри vote)".
    const nameLabel = spamVote.bannedUserUsername
      ? `@${spamVote.bannedUserUsername}`
      : (spamVote.bannedUserName || `id${spamVote.bannedUserId}`)
    const text = ctx.i18n.t('spam_vote.post_result.still_ban_done', {
      name: nameLabel,
      admin: adminLabel
    })
    try {
      await editHTML(ctx, ctx.callbackQuery.message.message_id, text, {
        reply_markup: { inline_keyboard: [] }
      })
    } catch (err) {
      if (!/message is not modified/.test(err.message || '')) {
        log.warn({ err: err.message, eventId }, 'mod.event still_ban: edit failed')
      }
    }

    logModEvent(ctx.db, {
      chatId: spamVote.chatId,
      eventType: 'override',
      actor: ctx.from,
      target: { id: spamVote.bannedUserId, name: spamVote.bannedUserName || spamVote.bannedUserUsername || null },
      action: 'ban 30d',
      reason: 'post_vote_clean_override'
    }).catch(() => {})

    return { render: false, toast: 'spam_vote.toast.still_ban_done' }
  }

  return { render: false, silent: true }
}

// Try to load a SpamVote by eventId. Used by post-result actions wired from
// vote-ui.js where the callback carries a SpamVote.eventId instead of a
// ModEvent.eventId. Returns null if the model is unavailable or no doc.
const findVoteByEventId = async (ctx, eventId) => {
  if (!ctx.db || !ctx.db.SpamVote || !eventId) return null
  try {
    return await ctx.db.SpamVote.findOne({ eventId })
  } catch {
    return null
  }
}

const handle = async (ctx, action, args) => {
  const eventId = args && args[0]
  if (!eventId) {
    return { render: false, toast: 'mod_event.toast.not_found' }
  }

  // `perma` / `still_ban` are spam-vote post-result actions (§10) — the
  // eventId is a SpamVote.eventId, not a ModEvent. Handle them inline so
  // we don't have to fabricate a ModEvent stub.
  if (action === 'perma' || action === 'still_ban') {
    return handlePostVoteAction(ctx, action, eventId)
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
    // Admin check must target the group where the mod-event happened, not
    // ctx.chat — which is the DM when the button was tapped from the PM
    // deep-link expanded card (/start mod_event_<id>).
    const viewerIsAdmin = await adminCache.isUserAdmin(ctx.telegram, event.chatId, ctx.from && ctx.from.id)
    if (!viewerIsAdmin) {
      return { render: false, toast: 'menu.access.only_admins' }
    }
    const result = await tryUndo(ctx, event)
    if (!result.ok) {
      log.warn({ err: result.err, eventId }, 'mod.event undo: failed')
      return { render: false, toast: 'mod_event.toast.undo_failed' }
    }
    // Roll back the data-layer side-effects of the original auto-action:
    // reputation boost, drop global ban, ++manualUnbans, --spamDetections
    // (floored at 0), per-chat whitelist. Without this the user stays
    // `restricted` and the very next message is auto-banned again — which
    // is exactly the cascade we observed in production (e.g. one admin
    // overriding the same user 6× in 8 minutes). Channel targets are
    // no-op'd inside applyAdminOverride. Failure is non-fatal: the
    // Telegram-side unban already succeeded above and is the user-visible
    // win; reputation rollback is best-effort.
    if (ctx.db) {
      await applyAdminOverride(ctx.db, {
        userId: event.targetId,
        chatId: event.chatId
      }).catch(err => log.warn({ err: err.message, eventId }, 'mod.event undo: applyAdminOverride failed'))
    }
    const adminName = ctx.from && (ctx.from.first_name || ctx.from.username)
      ? (ctx.from.first_name || ctx.from.username)
      : String(ctx.from && ctx.from.id)
    const updated = await modEvent.updateModEvent(ctx.db, eventId, {
      actionType: 'override',
      actorId: ctx.from && ctx.from.id,
      actorName: adminName
    })
    const overrideEvent = updated || { ...event.toObject(), actionType: 'override', actorId: ctx.from && ctx.from.id, actorName: adminName }
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

    const { text: overrideText } = modEvent.buildCompactText(ctx.i18n, overrideEvent, buildTarget(overrideEvent))
    const fromPm = ctx.chat && ctx.chat.type === 'private'

    // Always update the group notification (if the bot still knows where it
    // lives) — this is the message other members can see. Tolerate missing
    // refs: the notification may have aged out or been deleted.
    if (event.notificationChatId && event.notificationMessageId) {
      try {
        await ctx.telegram.callApi('editMessageText', {
          chat_id: event.notificationChatId,
          message_id: event.notificationMessageId,
          text: overrideText,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] }
        })
        await scheduleDeletion(ctx.db, {
          chatId: event.notificationChatId,
          messageId: event.notificationMessageId,
          delayMs: policy.mod_event_override,
          source: `mod_event:override:${event.actionType}`
        }, ctx.telegram).catch(() => {})
      } catch (err) {
        if (!/message is not modified|message to edit not found/.test(err.message || '')) {
          log.warn({ err: err.message, eventId }, 'mod.event undo: group edit failed')
        }
      }
    }

    // Update the message we're replying to. In group that IS the notification
    // (already edited above — ignore "not modified"); in PM that's the
    // expanded card the admin is staring at, swap it to a compact override.
    if (fromPm || !event.notificationChatId) {
      try {
        await editHTML(ctx, ctx.callbackQuery.message.message_id, overrideText, {
          reply_markup: { inline_keyboard: [] }
        })
      } catch (err) {
        if (!/message is not modified/.test(err.message || '')) {
          log.warn({ err: err.message, eventId, fromPm }, 'mod.event undo: local edit failed')
        }
      }
    }

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
  tryUndo,
  handlePostVoteAction
}
