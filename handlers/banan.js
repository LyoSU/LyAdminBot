const humanizeDuration = require('humanize-duration')
const { userName, getRandomInt } = require('../utils')
const { mapTelegramError } = require('../helpers/error-mapper')
const { scheduleDeletion } = require('../helpers/message-cleanup')
const { isSenderAdmin } = require('../helpers/is-sender-admin')
const { replyHTML } = require('../helpers/reply-html')
const modEvent = require('../helpers/mod-event')
const { logModEvent } = require('../helpers/mod-log')
const policy = require('../helpers/cleanup-policy')
const { renderPicker } = require('../helpers/menu/screens/mod-ban-picker')
const { sendRightsCard } = require('../helpers/menu/screens/mod-rights')
const { ackOnTarget, REACTIONS } = require('../helpers/reactions')

const BAN_UNITS = { m: 60, h: 3600, d: 86400 }
const MAX_BAN = 364 * 24 * 60 * 60
const MIN_BAN = 60
const SELF_BAN_CLEANUP_DELAY = 15 * 1000

/**
 * Get easter egg i18n key based on ban context.
 * Returns null for normal ban message.
 */
function getEasterEggKey (banTime, isSelfBan, banMember) {
  if (banTime === 69 || banTime === 69 * 60) return 'banan.easter.nice'
  if (banTime === 420 || banTime === 420 * 60) return 'banan.easter.blaze'
  if (banTime > 7 * 24 * 60 * 60) return 'banan.easter.huge'
  if (banTime === 60) return 'banan.easter.minute_exact'

  if (isSelfBan && Math.random() < 0.3) {
    const count = banMember?.banan?.num || 0
    if (count >= 5) return 'banan.easter.self_legend'
    if (count >= 2) return 'banan.easter.self_again'
    return 'banan.easter.self'
  }

  if (banMember?.banan?.num === 0 && banMember.stats?.textTotal > 100) {
    return 'banan.easter.first_after_many'
  }

  const milestones = [10, 25, 50, 100, 200, 500, 1000]
  if (banMember && milestones.includes(banMember.banan.num + 1)) {
    return 'banan.easter.round_number'
  }

  return null
}

function clampBanTime (seconds) {
  return Math.max(MIN_BAN, Math.min(MAX_BAN, seconds))
}

function formatDuration (seconds, ctx) {
  return humanizeDuration(seconds * 1000, {
    language: ctx.i18n.locale(),
    fallbacks: ['en']
  })
}

async function ensureBanMember (ctx, userId) {
  if (!ctx.group.members[userId]) {
    ctx.group.members[userId] = await ctx.db.GroupMember.findOne({
      group: ctx.group.info,
      telegram_id: userId
    })
  }
  return ctx.group.members[userId]
}

/**
 * Ban a sender_chat (channel) — separate flow from user bans.
 */
async function banSenderChat (ctx, replySenderChat, unixBanTime, banDuration, banUser) {
  const linkedChatId = ctx.group?.info?.linked_chat_id

  if (ctx.message.reply_to_message.is_automatic_forward ||
      (linkedChatId && replySenderChat.id === linkedChatId)) {
    return ctx.replyWithHTML(ctx.i18n.t('banan.cant_ban_linked_channel'))
  }

  await ctx.tg.callApi('banChatSenderChat', {
    chat_id: ctx.chat.id,
    sender_chat_id: replySenderChat.id,
    until_date: unixBanTime
  })

  await ctx.replyWithHTML(ctx.i18n.t('banan.suc', {
    name: userName(banUser, true),
    duration: banDuration
  }))
}

/**
 * Schedule cleanup of self-ban command and response messages.
 */
function scheduleSelBanCleanup (ctx, responseMessageId) {
  if (!ctx.db) return
  scheduleDeletion(ctx.db, {
    chatId: ctx.chat.id,
    messageId: responseMessageId,
    delayMs: SELF_BAN_CLEANUP_DELAY,
    source: 'cmd_banan'
  }, ctx.telegram)
  scheduleDeletion(ctx.db, {
    chatId: ctx.chat.id,
    messageId: ctx.message.message_id,
    delayMs: SELF_BAN_CLEANUP_DELAY,
    source: 'cmd_banan'
  }, ctx.telegram)
}

/**
 * Parse ban time from admin command arguments.
 *   { banTime, banUser, autoBan, explicit }
 *     explicit — true when the admin typed a duration literally (e.g. `/banan 5m`).
 *     autoBan  — default fallback (no arg, not already restricted) with stack-ramping.
 *     banTime  — -1 signals the unban path (target is already restricted).
 */
async function parseAdminBan (ctx, arg) {
  const banUser = ctx.message.reply_to_message.from

  if (parseInt(arg[1], 10) > 0) {
    let banType = arg[1].slice(-1)
    if (!BAN_UNITS[banType]) banType = 'm'
    return {
      banTime: parseInt(arg[1], 10) * BAN_UNITS[banType],
      banUser,
      autoBan: false,
      explicit: true
    }
  }

  const replyMember = await ctx.telegram.getChatMember(
    ctx.message.chat.id,
    ctx.message.reply_to_message.from.id
  )

  if (replyMember.status === 'restricted') {
    return { banTime: -1, banUser, autoBan: false, explicit: false }
  }

  return {
    banTime: ctx.group.info.settings.banan.default,
    banUser,
    autoBan: true,
    explicit: false
  }
}

/**
 * Post the /banan quick-picker message with inline duration buttons and
 * schedule its auto-delete. Returns the sent message or null on failure.
 */
async function sendBanPicker (ctx, targetUser) {
  const targetName = userName(targetUser, true)
  const { text, keyboard } = renderPicker(ctx, {
    targetName,
    targetId: targetUser.id
  })

  let sent
  try {
    sent = await replyHTML(ctx, text, {
      reply_markup: keyboard,
      reply_to_message_id: ctx.message.message_id
    })
  } catch (_err) {
    return null
  }

  if (sent && sent.message_id && ctx.db) {
    scheduleDeletion(ctx.db, {
      chatId: ctx.chat.id,
      messageId: sent.message_id,
      delayMs: policy.quick_picker,
      source: 'mod_ban_picker'
    }, ctx.telegram).catch(() => {})
  }
  return sent
}

/**
 * Send the unified moderation-result message (compact one-liner + [↩️ Скасувати]).
 * Creates a ModEvent row so the existing mod.event screen handles the undo.
 */
async function sendBanResult (ctx, {
  targetUser,
  banTime,
  banDuration,
  easterKey,
  count,
  adminUser
}) {
  let event = null
  if (ctx.db && ctx.db.ModEvent) {
    try {
      event = await modEvent.createModEvent(ctx.db, {
        chatId: ctx.chat.id,
        actorId: adminUser && adminUser.id,
        actorName: adminUser && (adminUser.first_name || adminUser.username),
        targetId: targetUser.id,
        targetName: targetUser.first_name,
        targetUsername: targetUser.username,
        targetTitle: targetUser.title,
        actionType: 'manual_ban'
      })
    } catch (_err) { /* best-effort */ }
  }

  // The result message mostly reuses the legacy `banan.*` locale key so
  // existing easter eggs still fire. We append the undo button on top.
  const bodyKey = easterKey || 'banan.suc'
  const body = ctx.i18n.t(bodyKey, {
    name: userName(targetUser, true),
    duration: banDuration,
    count
  })

  const keyboard = event
    ? modEvent.buildCompactKeyboard(ctx.i18n, event)
    : { inline_keyboard: [] }

  let sent
  try {
    sent = await replyHTML(ctx, body, { reply_markup: keyboard })
  } catch (_err) {
    return null
  }

  if (sent && sent.message_id && event && ctx.db) {
    try {
      await modEvent.updateModEvent(ctx.db, event.eventId, {
        notificationChatId: ctx.chat.id,
        notificationMessageId: sent.message_id
      })
    } catch (_err) { /* best-effort */ }
    // Schedule undo-button lifetime. Per spec the button lives 60s, then
    // the message itself is pruned via the standard deletion path (we do
    // not edit the button out — deleting the card is cleaner).
    if (banTime > 0) {
      scheduleDeletion(ctx.db, {
        chatId: ctx.chat.id,
        messageId: sent.message_id,
        delayMs: policy.banan_undo,
        source: 'banan_undo'
      }, ctx.telegram).catch(() => {})
    }
  }
  return sent
}

/**
 * Execute the actual ban: restrictChatMember, record stats, post the
 * result card. Exposed as `module.exports.performBan` so the quick-picker
 * screen can re-enter the flow from a callback.
 *
 * @param {Object} ctx — Telegraf context. For the picker path, this is
 *   the CALLBACK context (no ctx.message). For the legacy path, it's the
 *   message context.
 * @param {Object} opts
 * @param {number} opts.targetId
 * @param {number} opts.seconds  — 0 = permanent, otherwise > 0
 * @param {Object} [opts.targetUser] — pre-loaded user object; if absent,
 *   we resolve via getChatMember.
 * @param {Object} opts.adminUser — the admin who triggered the action.
 * @param {number} [opts.deletePickerMessageId] — message_id of the picker
 *   to delete once the ban succeeds.
 * @returns {Promise<{ok: boolean, toastKey?: string}>}
 */
async function performBan (ctx, opts = {}) {
  const { targetId, seconds, adminUser, deletePickerMessageId } = opts
  let targetUser = opts.targetUser

  if (!targetUser) {
    try {
      const m = await ctx.telegram.getChatMember(ctx.chat.id, targetId)
      targetUser = m && m.user
    } catch (_err) {
      return { ok: false, toastKey: 'menu.mod.ban.picker.failed' }
    }
  }
  if (!targetUser) return { ok: false, toastKey: 'menu.mod.ban.picker.failed' }

  const isPermanent = seconds === 0
  const banTime = isPermanent ? 0 : clampBanTime(seconds)
  const now = Math.floor(Date.now() / 1000)
  const unixBanTime = isPermanent ? 0 : now + banTime
  const banDuration = isPermanent
    ? ctx.i18n.t('menu.mod.ban.picker.dur_forever_human')
    : formatDuration(banTime, ctx)

  // Execute the ban via the appropriate API.
  try {
    if (isPermanent) {
      await ctx.telegram.callApi('banChatMember', {
        chat_id: ctx.chat.id,
        user_id: targetId
      })
    } else {
      await ctx.telegram.restrictChatMember(ctx.chat.id, targetId, {
        until_date: unixBanTime
      })
    }
  } catch (error) {
    await maybeShowRightsCard(ctx, error, 'banan', targetUser)
    return { ok: false, toastKey: mapTelegramError(error, 'banan') }
  }

  // Update GroupMember stats (best-effort).
  let banMember = null
  try {
    banMember = await ensureBanMember(ctx, targetId)
  } catch (_err) { /* non-fatal */ }

  const count = banMember ? (banMember.banan.num || 0) + 1 : 1
  const easterKey = banMember
    ? getEasterEggKey(banTime || 9999 * 24 * 60 * 60, false, banMember)
    : null

  // Delete the picker message (best-effort; may have already been deleted
  // by the cleanup-policy timer if the admin waited too long).
  if (deletePickerMessageId) {
    ctx.telegram.deleteMessage(ctx.chat.id, deletePickerMessageId).catch(() => {})
  }

  await sendBanResult(ctx, {
    targetUser,
    banTime: banTime || Infinity,
    banDuration,
    easterKey,
    count,
    adminUser
  })

  // Audit: admin ban via quick-picker. `isPermanent` picks the manual_ban
  // vs manual_mute split — mirrors mod-event's actionType distinction.
  logModEvent(ctx.db, {
    chatId: ctx.chat.id,
    eventType: isPermanent ? 'manual_ban' : 'manual_mute',
    actor: adminUser,
    target: targetUser,
    action: banDuration
  }).catch(() => {})

  // Persist stats.
  if (banMember) {
    banMember.banan.num += 1
    banMember.banan.sum += (banTime || 0)
    banMember.banan.last = {
      who: adminUser && adminUser.id,
      how: banTime || 0,
      time: Math.floor(Date.now() / 1000)
    }
    banMember.banan.time = Date.now()
    try { await banMember.save() } catch (_err) { /* non-fatal */ }
  }

  return { ok: true }
}

/**
 * Detect the "missing permissions" error path and, when applicable,
 * replace the default 1-liner with the rich rights card (§8). Falls
 * through to the default error reply in all other cases.
 */
async function maybeShowRightsCard (ctx, error, action, targetUser) {
  const errorKey = mapTelegramError(error, action)
  if (!errorKey.endsWith('error_no_rights')) return false
  try {
    await sendRightsCard(ctx, { action, targetUser })
    return true
  } catch (_err) {
    return false
  }
}

module.exports = async (ctx) => {
  const arg = ctx.message.text.split(/ +/)
  const isAdmin = await isSenderAdmin(ctx)

  let banTime = getRandomInt(60, 600)
  let banUser = ctx.from
  let autoBan = false
  let explicit = false

  if (isAdmin) {
    if (ctx.message.reply_to_message) {
      const parsed = await parseAdminBan(ctx, arg)
      banTime = parsed.banTime
      banUser = parsed.banUser
      autoBan = parsed.autoBan
      explicit = parsed.explicit

      // Quick-picker (§6): admin replied without a duration and target is
      // NOT already restricted. Show the picker instead of the default
      // auto-ban. Restricted targets fall through to the unban path below.
      if (!explicit && banTime > 0 && !autoBan) {
        // This branch shouldn't hit — parseAdminBan only returns > 0 when
        // explicit is true, or < 0 for unban. Guard anyway.
      }
      if (!explicit && autoBan && ctx.db && ctx.db.ModEvent) {
        // Show picker; bail out before the auto-ban runs.
        await sendBanPicker(ctx, banUser)
        return
      }
    } else {
      // Admin without reply — show stats
      return ctx.replyWithHTML(ctx.i18n.t('banan.show', {
        name: userName(ctx.from, true)
      }))
    }
  }

  const banMember = await ensureBanMember(ctx, banUser.id)
  if (!banMember) {
    return ctx.replyWithHTML(ctx.i18n.t('banan.error'))
  }

  if (autoBan) banTime *= (banMember.banan.stack + 1)

  // Unban flow (already restricted → lift restrictions)
  if (banTime < 0) {
    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, banUser.id, {
        until_date: ctx.message.date,
        can_send_messages: true,
        can_send_other_messages: true,
        can_send_media_messages: true,
        can_add_web_page_previews: true
      })
      await ctx.replyWithHTML(ctx.i18n.t('banan.pick', {
        name: userName(banUser, true)
      }))
      banMember.banan.sum -= (
        banMember.banan.last.how - (ctx.message.date - banMember.banan.last.time)
      )
    } catch (error) {
      if (await maybeShowRightsCard(ctx, error, 'banan', banUser)) {
        return
      }
      const errorKey = mapTelegramError(error, 'banan')
      return ctx.replyWithHTML(ctx.i18n.t(errorKey))
    }
    banMember.banan.time = Date.now()
    return banMember.save()
  }

  // Ban flow (explicit duration or non-admin joke-path)
  banTime = clampBanTime(banTime)
  const now = Math.floor(Date.now() / 1000)
  const unixBanTime = now + banTime
  const banDuration = formatDuration(banTime, ctx)
  const isSelfBan = ctx.from.id === banUser.id

  // Channel ban — separate API
  if (ctx.message.reply_to_message?.sender_chat) {
    return banSenderChat(ctx, ctx.message.reply_to_message.sender_chat, unixBanTime, banDuration, banUser)
  }

  // User ban
  try {
    await ctx.telegram.restrictChatMember(ctx.chat.id, banUser.id, {
      until_date: unixBanTime
    })
  } catch (error) {
    if (await maybeShowRightsCard(ctx, error, 'banan', banUser)) {
      return
    }
    const errorKey = mapTelegramError(error, 'banan')
    return ctx.replyWithHTML(ctx.i18n.t(errorKey))
  }

  if (banUser.id === 686968130) {
    await ctx.replyWithDocument(
      { source: 'assets/arkasha_banan.webp' },
      { reply_to_message_id: ctx.message.message_id }
    ).catch(() => {})
  }

  // 🍌 reaction on the muted user's message (§15). Cosmetic — silently
  // swallows failures inside reactions.js if reactions are disabled in
  // the chat or the API call races the delete.
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.message_id) {
    ackOnTarget(ctx, ctx.message.reply_to_message.message_id, REACTIONS.banan).catch(() => {})
  }

  const easterKey = getEasterEggKey(banTime, isSelfBan, banMember)

  // Admin-triggered explicit ban → unified mod-event card w/ undo.
  // Non-admin joke-path (self-random-ban) → legacy reply, no undo.
  let message
  if (isAdmin && explicit) {
    message = await sendBanResult(ctx, {
      targetUser: banUser,
      banTime,
      banDuration,
      easterKey,
      count: (banMember.banan.num || 0) + 1,
      adminUser: ctx.from
    })
  }
  if (!message) {
    message = await ctx.replyWithHTML(ctx.i18n.t(easterKey || 'banan.suc', {
      name: userName(banUser, true),
      duration: banDuration,
      count: (banMember.banan.num || 0) + 1
    }))
  }

  banMember.banan.num += 1
  banMember.banan.sum += banTime
  banMember.banan.last = {
    who: ctx.from.id,
    how: banTime,
    time: ctx.message.date
  }
  banMember.banan.time = Date.now()
  if (autoBan) banMember.banan.stack += 1
  await banMember.save()

  // Audit admin-triggered bans; skip random self-bans (joke path).
  if (isAdmin && explicit && !isSelfBan) {
    logModEvent(ctx.db, {
      chatId: ctx.chat.id,
      eventType: 'manual_mute',
      actor: ctx.from,
      target: banUser,
      action: banDuration
    }).catch(() => {})
  }

  if (isSelfBan) {
    scheduleSelBanCleanup(ctx, message.message_id)
  }
}

module.exports.performBan = performBan
module.exports.sendBanPicker = sendBanPicker
module.exports.sendBanResult = sendBanResult
