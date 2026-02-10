const { userName } = require('../utils')
const { checkSpam, getSpamSettings, humanizeReason } = require('../helpers/spam-check')
const { processSpamAction } = require('../helpers/reputation')
const { createVoteEvent, getAccountAgeDays } = require('../helpers/vote-ui')
const { addSignature } = require('../helpers/spam-signatures')
const e = require('../helpers/emoji-map')
const { report: reportLog } = require('../helpers/logger')
const { scheduleDeletion } = require('../helpers/message-cleanup')

// Rate limiting: max 3 reports per user per 5 minutes
const reportCooldowns = new Map()
const COOLDOWN_MS = 5 * 60 * 1000
const MAX_REPORTS = 3

// Periodic cleanup of stale cooldown entries (every 10 minutes)
setInterval(() => {
  const now = Date.now()
  for (const [userId, reports] of reportCooldowns) {
    const recent = reports.filter(time => now - time < COOLDOWN_MS)
    if (recent.length === 0) {
      reportCooldowns.delete(userId)
    } else {
      reportCooldowns.set(userId, recent)
    }
  }
}, 10 * 60 * 1000)

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

  // Check if this is a channel post
  const senderChat = replyMsg.sender_chat
  const isChannelPost = senderChat && senderChat.type === 'channel'
  const isAnonymousAdmin = senderChat && senderChat.id === ctx.chat.id

  // Can't report anonymous admins
  if (isAnonymousAdmin) {
    return ctx.reply(ctx.i18n.t('report.cant_report_admin'))
  }

  // Can't report linked channel (discussion channel attached to the group)
  const linkedChatId = ctx.group && ctx.group.info && ctx.group.info.linked_chat_id
  const isLinkedChannel = replyMsg.is_automatic_forward || (linkedChatId && senderChat && senderChat.id === linkedChatId)
  if (isLinkedChannel) {
    return ctx.reply(ctx.i18n.t('report.cant_report_admin'))
  }

  // For channel posts, use sender_chat; for regular messages, use from
  const targetUser = isChannelPost ? senderChat : replyMsg.from
  const targetId = isChannelPost ? senderChat.id : (replyMsg.from && replyMsg.from.id)

  // Validate we have a valid target
  if (!targetUser || !targetId) {
    return ctx.reply(ctx.i18n.t('report.invalid_target'))
  }

  // Can't report bots or self (only for non-channel posts)
  if (!isChannelPost) {
    if (!targetUser || targetUser.is_bot) {
      return ctx.reply(ctx.i18n.t('report.cant_report_bot'))
    }

    if (targetId === ctx.from.id) {
      return ctx.reply(ctx.i18n.t('report.cant_report_self'))
    }

    // Can't report admins
    try {
      const targetMember = await ctx.telegram.getChatMember(ctx.chat.id, targetId)
      if (targetMember && ['creator', 'administrator'].includes(targetMember.status)) {
        return ctx.reply(ctx.i18n.t('report.cant_report_admin'))
      }
    } catch (e) {
      // User might have left - continue anyway
    }
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
    // Fetch or create target user info from database (skip for channels - they're not users)
    let targetUserInfo = null
    if (!isChannelPost) {
      try {
        targetUserInfo = await ctx.db.User.findOneAndUpdate(
          { telegram_id: targetId },
          {
            $setOnInsert: {
              first_name: targetUser.first_name,
              last_name: targetUser.last_name,
              username: targetUser.username,
              globalStats: {
                totalMessages: 0,
                groupsActive: 0,
                groupsList: [],
                firstSeen: new Date(),
                lastActive: new Date(),
                spamDetections: 0,
                deletedMessages: 0,
                cleanMessages: 0,
                manualUnbans: 0
              },
              reputation: {
                score: 50,
                status: 'neutral',
                lastCalculated: new Date()
              }
            }
          },
          { upsert: true, new: true }
        )
      } catch (dbErr) {
        reportLog.error({ err: dbErr.message }, 'DB error')
      }
    }

    // Ensure globalStats and reputation exist (for users created before reputation system)
    if (targetUserInfo) {
      if (!targetUserInfo.globalStats) {
        targetUserInfo.globalStats = {
          totalMessages: 0,
          groupsActive: 0,
          groupsList: [],
          firstSeen: new Date(),
          lastActive: new Date(),
          spamDetections: 0,
          deletedMessages: 0,
          cleanMessages: 0,
          manualUnbans: 0
        }
      }
      if (!targetUserInfo.reputation) {
        targetUserInfo.reputation = {
          score: 50,
          status: 'neutral',
          lastCalculated: new Date()
        }
      }
    }

    // Fetch target user's per-group stats (skip for channels)
    let targetGroupMember = null
    if (!isChannelPost && ctx.group && ctx.group.info && ctx.group.info._id) {
      try {
        targetGroupMember = await ctx.db.GroupMember.findOne({
          group: ctx.group.info._id,
          telegram_id: targetId
        })
      } catch (dbErr) {
        reportLog.error({ err: dbErr.message }, 'GroupMember DB error')
      }
    }

    // Create a mock context for checkSpam with the target user's info
    const mockGroup = ctx.group ? {
      ...ctx.group,
      members: {
        ...ctx.group.members,
        [targetUser.id]: targetGroupMember || { stats: { messagesCount: 0 } }
      }
    } : null

    const mockCtx = {
      ...ctx,
      telegram: ctx.telegram, // Explicitly pass telegram API
      chat: ctx.chat,
      botInfo: ctx.botInfo,
      from: targetUser,
      message: replyMsg,
      group: mockGroup,
      session: {
        ...ctx.session,
        userInfo: targetUserInfo
      }
    }

    // Debug: log user data being checked
    const globalStats = (targetUserInfo && targetUserInfo.globalStats) || {}
    const rep = (targetUserInfo && targetUserInfo.reputation) || {}
    const groupMsgs = (targetGroupMember && targetGroupMember.stats && targetGroupMember.stats.messagesCount) || 0
    reportLog.debug({
      userId: targetUser.id,
      firstName: targetUser.first_name,
      groupMsgs,
      globalMsgs: globalStats.totalMessages || 0,
      groups: globalStats.groupsActive || 0,
      reputation: rep.score || 50,
      status: rep.status || 'neutral'
    }, 'Checking user')

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

    if (result.isSpam && result.confidence >= 50) {
      // Spam detected - take action
      const muteDuration = result.confidence >= 85 ? 86400 : 3600 // 24h or 1h

      // Try to restrict user or ban channel
      let actionTaken = false
      try {
        const botMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id)
        if (botMember.can_restrict_members) {
          if (isChannelPost) {
            // For channels, use banChatSenderChat
            await ctx.telegram.callApi('banChatSenderChat', {
              chat_id: ctx.chat.id,
              sender_chat_id: targetId
            })
            actionTaken = true
            reportLog.info({ channelTitle: targetUser.title }, 'Banned channel from posting')
          } else {
            // For regular users, use restrictChatMember
            await ctx.telegram.restrictChatMember(ctx.chat.id, targetId, {
              can_send_messages: false,
              can_send_media_messages: false,
              can_send_other_messages: false,
              can_add_web_page_previews: false,
              until_date: Math.floor(Date.now() / 1000) + muteDuration
            })
            actionTaken = true
          }
        }
      } catch (e) {
        reportLog.error({ err: e.message }, 'Failed to restrict')
      }

      // Try to delete message
      let deleted = false
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, replyMsg.message_id)
        deleted = true
      } catch (e) {
        reportLog.error({ err: e.message }, 'Failed to delete')
      }

      // Delete the "analyzing" status message
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id)
      } catch (e) { /* ignore */ }

      // If confidence < 85, create vote event for community verification
      if (result.confidence < 85 && (actionTaken || deleted)) {
        try {
          // Create vote context similar to spam-check middleware
          // Ensure from has id property for createVoteEvent
          const voteCtx = {
            ...ctx,
            from: { ...targetUser, id: targetId },
            message: replyMsg,
            session: mockCtx.session
          }

          await createVoteEvent(voteCtx, {
            result,
            actionTaken: {
              muteSuccess: actionTaken,
              deleteSuccess: deleted,
              muteDuration
            },
            messageText: messageText || '[Media]',
            userContext: {
              reputationScore: targetUserInfo?.reputation?.score,
              reputationStatus: targetUserInfo?.reputation?.status,
              accountAgeDays: !isChannelPost ? getAccountAgeDays(targetId) : 0,
              messagesInGroup: targetGroupMember?.stats?.messagesCount || 0,
              groupsActive: targetUserInfo?.globalStats?.groupsActive || 0,
              signals: result.quickAssessment?.signals || []
            }
          })

          reportLog.info({
            target: targetName,
            reporter: reporterName,
            confidence: result.confidence
          }, 'Created vote event for uncertain spam (via report)')
        } catch (voteErr) {
          reportLog.error({ err: voteErr.message }, 'Failed to create vote event')
        }
      } else if (result.confidence >= 85) {
        // High confidence - no voting needed, just update reputation
        if (!isChannelPost && mockCtx.session.userInfo) {
          const spamResult = processSpamAction(mockCtx.session.userInfo, {
            userId: targetId,
            messageDeleted: deleted,
            confidence: result.confidence,
            reason: result.reason || 'Spam confirmed via report',
            muteSuccess: actionTaken,
            globalBanEnabled: spamSettings.globalBan !== false
          })

          if (spamResult.globalBanApplied) {
            reportLog.warn({
              userId: targetId,
              targetName,
              reporter: userName(ctx.from),
              confidence: result.confidence
            }, 'Global ban applied via report')
          }

          await mockCtx.session.userInfo.save()
        }

        // Add to SpamSignature (multi-layer hashing for future detection)
        if (messageText && ctx.db) {
          try {
            await addSignature(messageText, ctx.db, ctx.chat.id)
          } catch (sigError) {
            reportLog.error({ err: sigError.message }, 'Failed to add SpamSignature')
          }
        }

        // Send notification for high confidence spam
        const actionText = isChannelPost
          ? (actionTaken ? (deleted ? `${e.ban} + ${e.trash}` : `${e.ban}`) : (deleted ? `${e.trash}` : `${e.warn}`))
          : (actionTaken ? (deleted ? `${e.mute} + ${e.trash}` : `${e.mute}`) : (deleted ? `${e.trash}` : `${e.warn}`))

        const notificationMsg = await ctx.replyWithHTML(
          ctx.i18n.t('report.spam_found', {
            reporter: reporterName,
            target: targetName,
            confidence: result.confidence,
            reason: humanizeReason(result.reason, ctx.i18n) || ctx.i18n.t('spam_vote.reasons.default'),
            action: actionText
          }),
          { disable_web_page_preview: true }
        )

        // Schedule auto-delete after 30 seconds (persistent)
        if (ctx.db) {
          scheduleDeletion(ctx.db, {
            chatId: ctx.chat.id,
            messageId: notificationMsg.message_id,
            delayMs: 30000,
            source: 'report_spam'
          }, ctx.telegram)
        }
      }

      reportLog.info({ target: targetName, reporter: reporterName, confidence: result.confidence }, 'Spam action taken')
    } else {
      // Clean message - pick a random fun response
      const cleanVariants = ['report.clean', 'report.clean_thanks', 'report.clean_false_alarm', 'report.clean_all_good']
      const randomKey = cleanVariants[Math.floor(Math.random() * cleanVariants.length)]

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        ctx.i18n.t(randomKey, {
          reporter: reporterName,
          target: targetName,
          confidence: 100 - (result.confidence || 0)
        }),
        { parse_mode: 'HTML' }
      )

      reportLog.debug({ target: targetName, reporter: reporterName }, 'Clean')

      // Schedule auto-delete after 15 seconds (persistent)
      if (ctx.db) {
        scheduleDeletion(ctx.db, {
          chatId: ctx.chat.id,
          messageId: statusMsg.message_id,
          delayMs: 15000,
          source: 'report_clean'
        }, ctx.telegram)
      }
    }
  } catch (error) {
    reportLog.error({ err: error }, 'Report error')
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
