const { userName } = require('../utils')
const { checkSpam, getSpamSettings } = require('../helpers/spam-check')
const { calculateReputation } = require('../helpers/reputation')

// Rate limiting: max 3 reports per user per 5 minutes
const reportCooldowns = new Map()
const COOLDOWN_MS = 5 * 60 * 1000
const MAX_REPORTS = 3

const isRateLimited = (userId) => {
  const now = Date.now()
  const userReports = reportCooldowns.get(userId) || []

  // Clean old entries
  const recent = userReports.filter(time => now - time < COOLDOWN_MS)
  reportCooldowns.set(userId, recent)

  if (recent.length >= MAX_REPORTS) {
    const oldestReport = recent[0]
    const waitSeconds = Math.ceil((COOLDOWN_MS - (now - oldestReport)) / 1000)
    return waitSeconds
  }

  return false
}

const trackReport = (userId) => {
  const reports = reportCooldowns.get(userId) || []
  reports.push(Date.now())
  reportCooldowns.set(userId, reports)
}

/**
 * Handle /report command and @bot mentions
 * Forces AI spam check on replied message
 */
const handleReport = async (ctx) => {
  // Must be in a group
  if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) {
    return ctx.reply(ctx.i18n.t('report.only_group'))
  }

  // Must have a sender (not a service message)
  if (!ctx.from || !ctx.from.id) {
    return
  }

  // Must be a reply to a message
  const replyMsg = ctx.message && ctx.message.reply_to_message
  if (!replyMsg) {
    return ctx.reply(ctx.i18n.t('report.need_reply'))
  }

  // Can't report bots or self
  const targetUser = replyMsg.from
  if (!targetUser || targetUser.is_bot) {
    return ctx.reply(ctx.i18n.t('report.cant_report_bot'))
  }

  if (targetUser.id === ctx.from.id) {
    return ctx.reply(ctx.i18n.t('report.cant_report_self'))
  }

  // Can't report admins
  try {
    const targetMember = await ctx.telegram.getChatMember(ctx.chat.id, targetUser.id)
    if (targetMember && ['creator', 'administrator'].includes(targetMember.status)) {
      return ctx.reply(ctx.i18n.t('report.cant_report_admin'))
    }
  } catch (e) {
    // User might have left - continue anyway
  }

  // Check rate limit
  const waitTime = isRateLimited(ctx.from.id)
  if (waitTime) {
    return ctx.reply(ctx.i18n.t('report.rate_limited', { seconds: waitTime }))
  }

  // Check if spam check is enabled
  const spamSettings = getSpamSettings(ctx)
  if (!spamSettings || !spamSettings.enabled) {
    return ctx.reply(ctx.i18n.t('report.spam_check_disabled'))
  }

  // Track this report
  trackReport(ctx.from.id)

  // Get message text
  const messageText = replyMsg.text || replyMsg.caption || ''
  if (!messageText && !replyMsg.photo) {
    return ctx.reply(ctx.i18n.t('report.no_content'))
  }

  // Send "analyzing" message
  const statusMsg = await ctx.reply(ctx.i18n.t('report.analyzing'))

  try {
    // Fetch target user info from database
    let targetUserInfo = null
    try {
      targetUserInfo = await ctx.db.User.findOne({ telegram_id: targetUser.id })
    } catch (dbErr) {
      console.error('[REPORT] DB error:', dbErr.message)
    }

    // Create a mock context for checkSpam with the target user's info
    const mockCtx = {
      ...ctx,
      from: targetUser,
      message: replyMsg,
      session: {
        ...ctx.session,
        userInfo: targetUserInfo
      }
    }

    // Force spam check
    const result = await checkSpam(messageText || '[Media]', mockCtx, spamSettings)

    // Handle null result
    if (!result) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        ctx.i18n.t('report.error'),
        { parse_mode: 'HTML' }
      ).catch(() => {})
      return
    }

    // Build response
    const reporterName = userName(ctx.from, true)
    const targetName = userName(targetUser, true)

    if (result.isSpam && result.confidence >= 70) {
      // High confidence spam - take action
      const muteDuration = result.confidence >= 90 ? 86400 : 3600 // 24h or 1h

      // Try to restrict user
      let actionTaken = false
      try {
        const botMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id)
        if (botMember.can_restrict_members) {
          await ctx.telegram.restrictChatMember(ctx.chat.id, targetUser.id, {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            until_date: Math.floor(Date.now() / 1000) + muteDuration
          })
          actionTaken = true
        }
      } catch (e) {
        console.error('[REPORT] Failed to restrict:', e.message)
      }

      // Try to delete message
      let deleted = false
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, replyMsg.message_id)
        deleted = true
      } catch (e) {
        console.error('[REPORT] Failed to delete:', e.message)
      }

      // Update target's reputation
      if (mockCtx.session.userInfo) {
        const stats = mockCtx.session.userInfo.globalStats || (mockCtx.session.userInfo.globalStats = {})
        stats.spamDetections = (stats.spamDetections || 0) + 1
        if (deleted) {
          stats.deletedMessages = (stats.deletedMessages || 0) + 1
        }
        mockCtx.session.userInfo.reputation = calculateReputation(stats, targetUser.id)
        await mockCtx.session.userInfo.save()
      }

      // Edit status message
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        ctx.i18n.t('report.spam_found', {
          reporter: reporterName,
          target: targetName,
          confidence: result.confidence,
          reason: result.reason || 'Spam detected',
          action: actionTaken ? (deleted ? '🔇 Muted + 🗑 Deleted' : '🔇 Muted') : (deleted ? '🗑 Deleted' : '⚠️ No permissions')
        }),
        { parse_mode: 'HTML' }
      )

      console.log(`[REPORT] ✅ Spam confirmed: ${targetName} reported by ${reporterName} (${result.confidence}%)`)
    } else if (result.isSpam && result.confidence >= 50) {
      // Medium confidence - warn but don't act
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        ctx.i18n.t('report.suspicious', {
          reporter: reporterName,
          target: targetName,
          confidence: result.confidence,
          reason: result.reason || 'Potentially suspicious'
        }),
        { parse_mode: 'HTML' }
      )

      console.log(`[REPORT] ⚠️ Suspicious: ${targetName} reported by ${reporterName} (${result.confidence}%)`)
    } else {
      // Clean message
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        ctx.i18n.t('report.clean', {
          reporter: reporterName,
          target: targetName,
          confidence: 100 - (result.confidence || 0)
        }),
        { parse_mode: 'HTML' }
      )

      console.log(`[REPORT] ✓ Clean: ${targetName} reported by ${reporterName}`)
    }

    // Auto-delete status message after 30 seconds
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id)
      } catch (e) { /* ignore */ }
    }, 30000)
  } catch (error) {
    console.error('[REPORT] Error:', error)
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      ctx.i18n.t('report.error'),
      { parse_mode: 'HTML' }
    ).catch(() => {})
  }
}

/**
 * Check if message is a report trigger
 * Triggers: @botusername, @admin, @admins, @report
 * Must be a reply to a message
 */
const isBotMentionReport = (ctx) => {
  if (!ctx.message || !ctx.message.text) return false
  if (!ctx.message.reply_to_message) return false
  if (!ctx.botInfo || !ctx.botInfo.username) return false

  const botUsername = ctx.botInfo.username.toLowerCase()
  const text = ctx.message.text.toLowerCase()

  // Check for various report triggers
  const triggers = [
    `@${botUsername}`,
    '@admin',
    '@admins',
    '@report'
  ]

  return triggers.some(trigger => text.includes(trigger))
}

module.exports = {
  handleReport,
  isBotMentionReport
}
