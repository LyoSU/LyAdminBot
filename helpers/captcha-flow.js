// Orchestration for captcha gates.
//
// Two entry points:
//   startMidConfidenceCaptcha — invoked from middlewares/spam-check.js for
//     verdicts in [60, threshold). Deletes the suspect message, restricts
//     the user for 5 min, posts a compact `pending_captcha` mod-event with
//     a deep-link captcha button, persists a Captcha row, and arms an
//     in-process escalation timer that promotes the soft mute to a 24h
//     mute if the user doesn't pass before the row expires.
//
//   startGlobalBanAppeal — invoked from handlers/start.js when a globally
//     banned user opens PM. Returns the active or freshly minted Captcha
//     row so the caller can render the challenge.
//
// Resolution paths:
//   applyPass — clears restrictions, marks the User row as "passed", edits
//     the group notification (mid_confidence) or replies in PM (appeal),
//     writes a `captcha_passed` / `appeal_passed` ModLog row, cancels the
//     escalation timer, deletes the Captcha row.
//
//   applyFail — applies the equivalent fallback: mutes 24h (mid_confidence)
//     or rejects with an error toast and bumps the appeal counter
//     (global_ban_appeal).
//
// The mod.event SCREEN does not handle this — the captcha screen owns
// resolution because it knows whether the user picked correctly.
//
// In-process timer: a Map<challengeId, NodeJS.Timeout>. Survives only
// inside one bot instance; on restart, the row's TTL stays correct and
// the upstream `Captcha` TTL collection drops the row, but the unmute
// will not happen automatically. This is acceptable for the soft-mute
// path because the underlying `restrictChatMember(until_date=now+5min)`
// auto-expires server-side regardless. The escalation-to-24h mute on
// timeout DOES rely on this timer; on restart we lose that escalation
// for in-flight challenges. Documented as a known limitation; in practice
// the bot rarely restarts and the user is already restricted for 5 min,
// so the worst-case "free" is letting a borderline user back in.

const policy = require('./cleanup-policy')
const captcha = require('./captcha')
const modEvent = require('./mod-event')
const { logModEvent } = require('./mod-log')
const { editHTML, replyHTML } = require('./reply-html')
const { scheduleDeletion } = require('./message-cleanup')
const botPermissions = require('./bot-permissions')
const { notification: log } = require('./logger')

const MID_CONFIDENCE_TTL_MS = policy.captcha_window
const APPEAL_TTL_MS = policy.captcha_appeal_window
const FALLBACK_MUTE_SECONDS = 24 * 60 * 60
const APPEAL_FAIL_LOCK_MS = 30 * 24 * 60 * 60 * 1000
const MAX_FAILED_APPEALS_BEFORE_LOCK = 3

const escalationTimers = new Map()

const cancelTimer = (challengeId) => {
  const t = escalationTimers.get(challengeId)
  if (t) {
    clearTimeout(t)
    escalationTimers.delete(challengeId)
  }
}

const fullPermissions = () => ({
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
})

const restrictForCaptcha = (telegram, chatId, userId, untilSeconds) =>
  telegram.restrictChatMember(chatId, userId, {
    can_send_messages: false,
    can_send_media_messages: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    until_date: untilSeconds
  })

const liftRestrictions = (telegram, chatId, userId) =>
  telegram.restrictChatMember(chatId, userId, { permissions: fullPermissions() })

const mutateUserPassed = (userInfo) => {
  if (!userInfo) return
  userInfo.captchaPassedAt = new Date()
}

// ---- mid_confidence ------------------------------------------------------

/**
 * @returns {Promise<{ok: boolean, reason?: string, captcha?: object, event?: object}>}
 */
const startMidConfidenceCaptcha = async (ctx, opts = {}) => {
  const { senderInfo, message, confidence, reason } = opts
  if (!ctx || !ctx.telegram || !ctx.chat || !ctx.db || !ctx.db.Captcha || !ctx.db.ModEvent) {
    return { ok: false, reason: 'no_db' }
  }
  if (!senderInfo || !senderInfo.id || !message) {
    return { ok: false, reason: 'no_sender' }
  }
  const chatId = ctx.chat.id
  const userId = senderInfo.id

  // Honour bot-level restrict permission. Without it, the soft-mute is
  // unenforceable; we fall back to the existing "let through" behaviour
  // by returning ok:false. Spam-check treats this as a no-op.
  const perms = await botPermissions.resolve(ctx.telegram, chatId, ctx.botInfo && ctx.botInfo.id)
  if (perms && !perms.canRestrict) {
    return { ok: false, reason: 'no_restrict_perm' }
  }

  // Delete the suspect message (best-effort, including album siblings if
  // the album-buffer middleware aggregated them).
  const albumIds = Array.isArray(ctx.mediaGroupIds) && ctx.mediaGroupIds.length > 0
    ? ctx.mediaGroupIds
    : [message.message_id]
  await Promise.all(albumIds.map(async (mid) => {
    try { await ctx.telegram.deleteMessage(chatId, mid) } catch (_e) { /* permissive */ }
  }))

  const expiresAt = new Date(Date.now() + MID_CONFIDENCE_TTL_MS)
  const untilSeconds = Math.floor(expiresAt.getTime() / 1000)

  try {
    await restrictForCaptcha(ctx.telegram, chatId, userId, untilSeconds)
  } catch (err) {
    log.warn({ err, chatId, userId }, 'captcha-flow: restrict failed')
    return { ok: false, reason: 'restrict_failed' }
  }

  // Dedup: reuse an active row to keep the same challenge across re-clicks.
  let captchaRow = await ctx.db.Captcha.findActive({ userId, kind: 'mid_confidence' })
  let event

  if (!captchaRow) {
    const challenge = captcha.generateChallenge('mid_confidence')

    // Create the ModEvent first so we can stash its eventId on the row.
    try {
      event = await modEvent.createModEvent(ctx.db, {
        chatId,
        actorId: 0,
        targetId: userId,
        targetName: senderInfo.first_name,
        targetUsername: senderInfo.username,
        actionType: 'pending_captcha',
        reason,
        confidence,
        messagePreview: messageTextPreview(message)
      })
    } catch (err) {
      log.warn({ err }, 'captcha-flow: failed to create ModEvent')
    }

    try {
      captchaRow = await ctx.db.Captcha.create({
        userId,
        chatId,
        kind: 'mid_confidence',
        correctEmoji: challenge.correctEmoji,
        correctNameKey: challenge.correctNameKey,
        options: challenge.options,
        eventId: event && event.eventId,
        expiresAt
      })
    } catch (err) {
      log.error({ err }, 'captcha-flow: failed to create Captcha row')
      return { ok: false, reason: 'db_failed' }
    }
  } else if (captchaRow.eventId) {
    event = await modEvent.getModEvent(ctx.db, captchaRow.eventId)
  }

  // Send the compact pending_captcha line. We have to bypass
  // sendModEventNotification because that helper rebuilds the keyboard
  // from buildCompactKeyboard(); for pending_captcha we want a single URL
  // button that deep-links into the bot for the captcha screen.
  const botUsername = ctx.botInfo && ctx.botInfo.username
  const text = buildPendingCompactText(ctx, event, senderInfo)
  const keyboard = buildPendingCaptchaKeyboard(ctx, captchaRow.challengeId, botUsername)

  let sent
  try {
    sent = await replyHTML(ctx, text, { reply_markup: keyboard })
  } catch (err) {
    log.error({ err }, 'captcha-flow: failed to post pending notification')
  }

  if (sent && sent.message_id && event) {
    try {
      await modEvent.updateModEvent(ctx.db, event.eventId, {
        notificationChatId: chatId,
        notificationMessageId: sent.message_id
      })
    } catch (_e) { /* non-fatal */ }
  }

  // Auto-delete the pending line on the captcha-window TTL. If the user
  // passes / fails before then, applyPass / applyFail edit-then-reschedule
  // the deletion with their own TTL.
  if (sent && sent.message_id) {
    try {
      await scheduleDeletion(ctx.db, {
        chatId,
        messageId: sent.message_id,
        delayMs: MID_CONFIDENCE_TTL_MS,
        source: 'captcha:pending'
      }, ctx.telegram)
    } catch (_e) { /* non-fatal */ }
  }

  // Arm the escalation timer.
  scheduleEscalation(ctx, captchaRow, senderInfo)

  return { ok: true, captcha: captchaRow, event }
}

const messageTextPreview = (message) => {
  if (!message) return undefined
  const raw = (message.text || message.caption || '').trim()
  return raw ? raw.slice(0, 200) : undefined
}

const buildPendingCompactText = (ctx, event, target) => {
  const t = target || (event && {
    id: event.targetId,
    first_name: event.targetName,
    username: event.targetUsername
  })
  const name = modEvent.usernameLabel(t)
  return ctx.i18n.t('captcha.compact.pending', { name })
}

const buildPendingCaptchaKeyboard = (ctx, challengeId, botUsername) => {
  if (botUsername) {
    return {
      inline_keyboard: [[
        {
          text: ctx.i18n.t('captcha.btn.start'),
          url: `https://t.me/${botUsername}?start=captcha_${challengeId}`
        }
      ]]
    }
  }
  // Without botUsername we can't deep-link; render an inert button so the
  // user at least sees the prompt. The bot username is available in all
  // code paths in production, so this is a defence-in-depth fallback.
  return {
    inline_keyboard: [[
      { text: ctx.i18n.t('captcha.btn.start'), callback_data: 'm:v1:_noop' }
    ]]
  }
}

// In-process escalation. A timer fires at expiresAt; on fire it looks the
// row back up (in case it was deleted by a successful pass) and, if the
// row is still there, applies the standard 24h mute via applyFail.
const scheduleEscalation = (ctx, captchaRow, senderInfo) => {
  const challengeId = captchaRow.challengeId
  cancelTimer(challengeId)
  const delay = Math.max(0, captchaRow.expiresAt.getTime() - Date.now())
  const timer = setTimeout(async () => {
    escalationTimers.delete(challengeId)
    try {
      const stillActive = await ctx.db.Captcha.findOne({ challengeId })
      if (!stillActive) return
      await applyFail({
        db: ctx.db,
        telegram: ctx.telegram,
        i18n: ctx.i18n,
        botInfo: ctx.botInfo
      }, stillActive, { senderInfo, reason: 'timeout' })
    } catch (err) {
      log.warn({ err, challengeId }, 'captcha-flow: escalation timer crashed')
    }
  }, delay)
  // Don't keep the event loop alive just for a captcha timeout.
  if (typeof timer.unref === 'function') timer.unref()
  escalationTimers.set(challengeId, timer)
}

// ---- global_ban_appeal ---------------------------------------------------

/**
 * Idempotent: returns the active appeal row for this user, creating one
 * if needed. Returns { locked: true } when the user has hit the cumulative
 * appeal cap (3 attempts → 30 d cooldown).
 */
const startGlobalBanAppeal = async (ctx) => {
  if (!ctx || !ctx.db || !ctx.db.Captcha || !ctx.from) {
    return { ok: false, reason: 'no_db' }
  }
  const userInfo = ctx.session && ctx.session.userInfo
  if (userInfo && userInfo.captchaAppealsLockedUntil &&
      userInfo.captchaAppealsLockedUntil.getTime && userInfo.captchaAppealsLockedUntil.getTime() > Date.now()) {
    return { ok: false, locked: true, until: userInfo.captchaAppealsLockedUntil }
  }
  const userId = ctx.from.id
  let captchaRow = await ctx.db.Captcha.findActive({ userId, kind: 'global_ban_appeal' })
  if (captchaRow) return { ok: true, captcha: captchaRow, reused: true }

  const challenge = captcha.generateChallenge('global_ban_appeal')
  try {
    captchaRow = await ctx.db.Captcha.create({
      userId,
      chatId: null,
      kind: 'global_ban_appeal',
      correctEmoji: challenge.correctEmoji,
      correctNameKey: challenge.correctNameKey,
      options: challenge.options,
      expiresAt: new Date(Date.now() + APPEAL_TTL_MS)
    })
  } catch (err) {
    log.error({ err }, 'captcha-flow: failed to create appeal row')
    return { ok: false, reason: 'db_failed' }
  }
  return { ok: true, captcha: captchaRow, reused: false }
}

// ---- pass / fail ---------------------------------------------------------

/**
 * Apply a successful captcha. Caller is anything with telegram + db + i18n
 * (a Telegraf ctx works, but the screen passes a thinned-down deps object).
 */
const applyPass = async (deps, captchaRow, opts = {}) => {
  const { telegram, db, i18n } = deps
  if (!captchaRow) return { ok: false }
  cancelTimer(captchaRow.challengeId)
  // Single-use: drop the row first so a second click can't apply the
  // pass action a second time.
  try { await db.Captcha.consume(captchaRow.challengeId) } catch (_e) { /* non-fatal */ }

  if (captchaRow.kind === 'mid_confidence') {
    return applyMidPass({ telegram, db, i18n }, captchaRow, opts)
  }
  return applyAppealPass({ telegram, db, i18n }, captchaRow, opts)
}

const applyMidPass = async ({ telegram, db, i18n }, captchaRow, opts) => {
  const chatId = captchaRow.chatId
  const userId = captchaRow.userId
  try {
    await liftRestrictions(telegram, chatId, userId)
  } catch (err) {
    log.warn({ err, chatId, userId }, 'captcha-flow: lift restrictions failed')
  }

  // 24h soft whitelist on the User document. Persist via the standard
  // session writer if the caller passed userInfo; otherwise update the
  // User doc directly.
  if (opts.userInfo) {
    mutateUserPassed(opts.userInfo)
  } else if (db.User) {
    db.User.updateOne(
      { telegram_id: userId },
      { $set: { captchaPassedAt: new Date() } }
    ).catch(() => {})
  }

  // Edit the group notification: compact "passed" line, no buttons.
  const event = captchaRow.eventId
    ? await modEvent.getModEvent(db, captchaRow.eventId).catch(() => null)
    : null
  if (event && event.notificationChatId && event.notificationMessageId) {
    const targetName = event.targetName || (opts.senderInfo && opts.senderInfo.first_name) || `id${userId}`
    const text = i18n.t('captcha.compact.passed', { name: modEvent.usernameLabel({ first_name: targetName, username: event.targetUsername }) })
    try {
      await editHTML(
        { telegram, chat: { id: event.notificationChatId } },
        event.notificationMessageId,
        text,
        { reply_markup: { inline_keyboard: [] } }
      )
    } catch (err) {
      if (!/message is not modified/.test(err.message || '')) {
        log.warn({ err }, 'captcha-flow: pass edit failed')
      }
    }
    // Quick auto-delete of the success notice — it's a transient OK.
    try {
      await scheduleDeletion(db, {
        chatId: event.notificationChatId,
        messageId: event.notificationMessageId,
        delayMs: policy.captcha_pass_notice,
        source: 'captcha:passed'
      }, telegram)
    } catch (_e) { /* non-fatal */ }
    try {
      await modEvent.updateModEvent(db, event.eventId, { actionType: 'captcha_passed' })
    } catch (_e) { /* non-fatal */ }
  }

  logModEvent(db, {
    chatId,
    eventType: 'captcha_passed',
    actor: null,
    target: { id: userId, name: opts.senderInfo && opts.senderInfo.first_name },
    action: 'captcha pass',
    reason: `challengeId=${captchaRow.challengeId}`
  }).catch(() => {})

  return { ok: true, kind: 'mid_confidence' }
}

const applyAppealPass = async ({ db, i18n }, captchaRow, opts) => {
  const userId = captchaRow.userId
  if (opts.userInfo) {
    opts.userInfo.isGlobalBanned = false
    opts.userInfo.captchaAppealsUsed = (opts.userInfo.captchaAppealsUsed || 0) + 1
    opts.userInfo.captchaPassedAt = new Date()
  } else if (db.User) {
    await db.User.updateOne(
      { telegram_id: userId },
      {
        $set: { isGlobalBanned: false, captchaPassedAt: new Date() },
        $inc: { captchaAppealsUsed: 1 }
      }
    ).catch(() => {})
  }
  // Appeal events are user-scope (no group). chatId = 0 is the
  // documented sentinel; query side only cares about presence of
  // `appeal_*` eventType, not chatId equality.
  logModEvent(db, {
    chatId: 0,
    eventType: 'appeal_passed',
    actor: null,
    target: { id: userId },
    action: 'global_ban_appeal pass',
    reason: `challengeId=${captchaRow.challengeId}`
  }).catch(() => {})

  return { ok: true, kind: 'global_ban_appeal', message: i18n.t('captcha.appeal.passed') }
}

const applyFail = async (deps, captchaRow, opts = {}) => {
  const { telegram, db, i18n } = deps
  if (!captchaRow) return { ok: false }
  cancelTimer(captchaRow.challengeId)
  try { await db.Captcha.consume(captchaRow.challengeId) } catch (_e) { /* non-fatal */ }

  if (captchaRow.kind === 'mid_confidence') {
    return applyMidFail({ telegram, db, i18n }, captchaRow, opts)
  }
  return applyAppealFail({ db, i18n }, captchaRow, opts)
}

const applyMidFail = async ({ telegram, db, i18n }, captchaRow, opts) => {
  const chatId = captchaRow.chatId
  const userId = captchaRow.userId
  const muteUntil = Math.floor(Date.now() / 1000) + FALLBACK_MUTE_SECONDS
  try {
    await restrictForCaptcha(telegram, chatId, userId, muteUntil)
  } catch (err) {
    log.warn({ err, chatId, userId }, 'captcha-flow: fail mute failed')
  }

  const event = captchaRow.eventId
    ? await modEvent.getModEvent(db, captchaRow.eventId).catch(() => null)
    : null
  if (event && event.notificationChatId && event.notificationMessageId) {
    const targetName = event.targetName || (opts.senderInfo && opts.senderInfo.first_name) || `id${userId}`
    const text = i18n.t('captcha.compact.failed', {
      name: modEvent.usernameLabel({ first_name: targetName, username: event.targetUsername })
    })
    try {
      await editHTML(
        { telegram, chat: { id: event.notificationChatId } },
        event.notificationMessageId,
        text,
        { reply_markup: { inline_keyboard: [] } }
      )
    } catch (err) {
      if (!/message is not modified/.test(err.message || '')) {
        log.warn({ err }, 'captcha-flow: fail edit failed')
      }
    }
    try {
      await modEvent.updateModEvent(db, event.eventId, { actionType: 'captcha_failed' })
    } catch (_e) { /* non-fatal */ }
  }

  logModEvent(db, {
    chatId,
    eventType: 'captcha_failed',
    actor: null,
    target: { id: userId, name: opts.senderInfo && opts.senderInfo.first_name },
    action: opts.reason === 'timeout' ? 'captcha timeout' : 'captcha fail',
    reason: `challengeId=${captchaRow.challengeId}`
  }).catch(() => {})
  logModEvent(db, {
    chatId,
    eventType: 'auto_mute',
    actor: null,
    target: { id: userId, name: opts.senderInfo && opts.senderInfo.first_name },
    action: '24h',
    reason: 'captcha_failed'
  }).catch(() => {})

  return { ok: true, kind: 'mid_confidence', muted: true }
}

const applyAppealFail = async ({ db, i18n }, captchaRow, opts) => {
  const userId = captchaRow.userId
  let locked = false
  if (opts.userInfo) {
    opts.userInfo.captchaAppealsUsed = (opts.userInfo.captchaAppealsUsed || 0) + 1
    if (opts.userInfo.captchaAppealsUsed >= MAX_FAILED_APPEALS_BEFORE_LOCK) {
      opts.userInfo.captchaAppealsLockedUntil = new Date(Date.now() + APPEAL_FAIL_LOCK_MS)
      locked = true
    }
  } else if (db.User) {
    const updated = await db.User.findOneAndUpdate(
      { telegram_id: userId },
      { $inc: { captchaAppealsUsed: 1 } },
      { new: true }
    ).catch(() => null)
    if (updated && updated.captchaAppealsUsed >= MAX_FAILED_APPEALS_BEFORE_LOCK) {
      await db.User.updateOne(
        { telegram_id: userId },
        { $set: { captchaAppealsLockedUntil: new Date(Date.now() + APPEAL_FAIL_LOCK_MS) } }
      ).catch(() => {})
      locked = true
    }
  }

  logModEvent(db, {
    chatId: 0,
    eventType: 'appeal_failed',
    actor: null,
    target: { id: userId },
    action: 'global_ban_appeal fail',
    reason: `challengeId=${captchaRow.challengeId}`
  }).catch(() => {})

  return {
    ok: true,
    kind: 'global_ban_appeal',
    locked,
    message: i18n.t(locked ? 'captcha.appeal.locked' : 'captcha.appeal.failed')
  }
}

module.exports = {
  startMidConfidenceCaptcha,
  startGlobalBanAppeal,
  applyPass,
  applyFail,
  // Test seams.
  _escalationTimers: escalationTimers,
  _cancelTimer: cancelTimer,
  MID_CONFIDENCE_TTL_MS,
  APPEAL_TTL_MS,
  FALLBACK_MUTE_SECONDS,
  APPEAL_FAIL_LOCK_MS,
  MAX_FAILED_APPEALS_BEFORE_LOCK
}
