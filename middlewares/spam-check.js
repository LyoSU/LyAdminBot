const { userName } = require('../utils')
const { checkSpam, checkTrustedUser, getSpamSettings } = require('../helpers/spam-check')
const { saveSpamVector } = require('../helpers/spam-vectors')
const { generateEmbedding, extractFeatures } = require('../helpers/message-embeddings')
const { processSpamAction } = require('../helpers/reputation')
const { spam: spamLog, spamAction, reputation: repLog, notification: notifyLog } = require('../helpers/logger')

/**
 * Determine appropriate action based on spam confidence and user profile
 */
const determineAction = (result, context, threshold) => {
  if (!result.isSpam || result.confidence < threshold) {
    return { action: 'none' }
  }

  const confidence = result.confidence || 0

  // Very high confidence - immediate mute and delete
  if (confidence >= 90) {
    return {
      action: 'mute_and_delete',
      duration: context.isPremium ? 3600 : 86400, // 1h for premium, 24h for regular
      reason: result.reason
    }
  }

  // High confidence - warn first, then restrict on next offense
  if (confidence >= 80) {
    return {
      action: 'warn_and_restrict',
      duration: context.isPremium ? 1800 : 7200, // 30min for premium, 2h for regular
      reason: result.reason
    }
  }

  // Medium confidence - delete message only, no mute
  if (confidence >= threshold) {
    // For new users with suspicious messages - more aggressive actions
    if (context.messageCount <= 2 && context.isNewAccount) {
      return {
        action: 'warn_and_restrict',
        duration: context.isPremium ? 1800 : 7200,
        reason: result.reason
      }
    }

    return {
      action: 'delete_only',
      reason: result.reason
    }
  }

  return { action: 'none' }
}

/**
 * Extract links from a message text
 */
const extractLinks = (text) => {
  if (!text) return []
  const urlRegex = /(https?:\/\/[^\s]+)|(t\.me\/[^\s]+)|(www\.[^\s]+)/gi
  return text.match(urlRegex) || []
}

/**
 * Check if user account is potentially new based on ID
 * Telegram IDs above ~5B are from 2022+
 */
const isLikelyNewAccount = (userId) => userId > 5000000000

/**
 * Format user details string
 */
const formatUserDetails = (user) => {
  if (!user) return ''
  const details = []
  if (user.first_name) details.push(`First name: ${user.first_name}`)
  if (user.last_name) details.push(`Last name: ${user.last_name}`)
  if (user.is_bot) details.push('Is bot')
  return details.join(', ')
}

/**
 * Spam check middleware using hybrid ML approach
 */
module.exports = async (ctx) => {
  // Skip if not in a group chat or no user
  if (!ctx.chat || !['supergroup', 'group'].includes(ctx.chat.type) || !ctx.from) {
    return
  }

  // Skip if no group context or member data
  if (!ctx.group || !ctx.group.members) {
    return
  }

  // Get the actual sender ID and info
  // Prefer sender_chat only if it has a valid id, otherwise use ctx.from
  const senderChat = ctx.message && ctx.message.sender_chat
  const hasSenderChat = senderChat && senderChat.id
  const senderId = hasSenderChat ? senderChat.id : ctx.from.id
  const senderInfo = hasSenderChat ? senderChat : ctx.from

  // Check if spam check is enabled for this group
  const spamSettings = getSpamSettings(ctx)
  if (!spamSettings || spamSettings.enabled === false) {
    return false
  }

  // TEST MODE: Only via environment variable (not user-controllable)
  const isTestMode = process.env.SPAM_TEST_MODE === 'true'

  if (isTestMode) {
    spamLog.info('TEST MODE ENABLED - Bypassing all safety checks')
  }

  // Skip if message is a command (except in test mode)
  if (!isTestMode && ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) {
    return
  }

  // Skip Telegram service account (forwarded message info)
  if (!isTestMode && senderId === 777000) {
    spamLog.debug({ senderId }, 'Skipping Telegram service')
    return
  }

  // Skip anonymous admins (posting as the group itself)
  // Note: When admin posts anonymously, sender_chat.id === chat.id
  if (!isTestMode && hasSenderChat && senderChat.id === ctx.chat.id) {
    spamLog.debug({ chatId: ctx.chat.id, chatTitle: ctx.chat.title }, 'Skipping anonymous admin')
    return
  }

  // Check if this is a channel post (will be spam-checked, not skipped)
  const isChannelPost = hasSenderChat && senderChat.type === 'channel'
  if (isChannelPost) {
    spamLog.debug({ channelTitle: senderChat.title || senderId }, 'Checking channel')
  }

  // Only check actual user content (whitelist approach)
  const hasUserContent = ctx.message && (
    ctx.message.text ||
    ctx.message.caption ||
    ctx.message.photo ||
    ctx.message.video ||
    ctx.message.document ||
    ctx.message.audio ||
    ctx.message.voice ||
    ctx.message.video_note ||
    ctx.message.sticker ||
    ctx.message.animation
  )

  if (!hasUserContent) {
    return
  }

  // Unified trust check: local trusted list OR global reputation 'trusted'
  const userReputation = ctx.session && ctx.session.userInfo && ctx.session.userInfo.reputation
  const isLocalTrusted = checkTrustedUser(senderId, ctx)
  const isGlobalTrusted = userReputation && userReputation.status === 'trusted'

  if (!isTestMode && (isLocalTrusted || isGlobalTrusted)) {
    const trustSource = isLocalTrusted ? 'local_list' : 'global_reputation'
    spamLog.debug({
      userId: senderId,
      userName: userName(senderInfo),
      trustSource,
      score: userReputation ? userReputation.score : 'N/A'
    }, 'Skipping trusted user')
    return
  }

  // Dynamic check limit based on global reputation
  let checkLimit = 5 // default for neutral/unknown users
  if (userReputation) {
    if (userReputation.status === 'restricted') {
      checkLimit = Infinity // always check restricted users
    } else if (userReputation.status === 'suspicious') {
      checkLimit = 20 // check suspicious users longer
    } else if (userReputation.status === 'neutral' && userReputation.score < 60) {
      checkLimit = 10 // slightly more checks for low-neutral users
    }
  }

  // Check number of messages from the user (or force check in test mode)
  // For channel posts, always check (no member history to base decision on)
  const messageCount = (ctx.group.members[senderId] && ctx.group.members[senderId].stats && ctx.group.members[senderId].stats.messagesCount) || 0
  const shouldCheckSpam = isTestMode || isChannelPost || messageCount <= checkLimit

  // Log when using non-default check limit
  if (checkLimit !== 5 && shouldCheckSpam && !isChannelPost) {
    const repStatus = userReputation ? userReputation.status : 'unknown'
    const repScore = userReputation ? userReputation.score : 'N/A'
    spamLog.debug({ repStatus, repScore, checkLimit: checkLimit === Infinity ? 'unlimited' : checkLimit, messageCount }, 'Extended check for user')
  }

  // Check if we have member data OR if this is a channel post (always check channels)
  const hasMemberData = ctx.group && ctx.group.members && ctx.group.members[senderId] && ctx.group.members[senderId].stats
  if ((hasMemberData || isChannelPost) && shouldCheckSpam) {
    // Skip if user is an administrator (except in test mode)
    // Note: Skip admin check for channel posts (senderId is negative channel ID)
    if (!isTestMode && !isChannelPost) {
      try {
        const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, senderId)
        if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
          spamLog.debug({ userId: senderId, userName: userName(senderInfo) }, 'Skipping admin')
          return
        }
      } catch (error) {
        spamLog.warn({ userId: senderId, err: error.message }, 'Could not check admin status')
      }
    } else if (isTestMode) {
      spamLog.debug({ userId: senderId, userName: userName(senderInfo) }, 'TEST MODE - Bypassing admin check')
    }

    // Check message for spam
    if (ctx.message) {
      const originalText = ctx.message.text || ctx.message.caption || ''
      let messageText = originalText.trim()

      // Handle messages without text/caption
      if (!messageText) {
        if (ctx.message.sticker) {
          messageText = `[Sticker: ${ctx.message.sticker.emoji || 'unknown'}]`
        } else if (ctx.message.voice) {
          messageText = '[Voice message]'
        } else if (ctx.message.photo) {
          messageText = '[Photo]'
        } else if (ctx.message.document) {
          messageText = `[Document: ${ctx.message.document.file_name || 'unknown'}]`
        } else {
          messageText = '[Media message]'
        }
      }

      const actualMessageCount = hasMemberData ? ctx.group.members[senderId].stats.messagesCount : 0
      const senderType = isChannelPost ? 'channel' : 'user'
      spamLog.info({
        senderType,
        userName: userName(senderInfo),
        userId: senderId,
        messageCount: isTestMode ? 'TEST' : (isChannelPost ? 'channel' : actualMessageCount)
      }, 'Checking message')

      // Build context for spam check
      const context = {
        userId: senderId,
        groupName: ctx.chat.title,
        userName: userName(senderInfo),
        userDetails: formatUserDetails(senderInfo),
        languageCode: senderInfo.language_code,
        isPremium: isTestMode ? false : senderInfo.is_premium, // Ignore premium in test mode
        isNewAccount: isTestMode ? true : isLikelyNewAccount(senderId), // Force new account in test mode
        username: senderInfo.username,
        messageCount: isTestMode ? 1 : actualMessageCount, // Force first message in test mode
        links: extractLinks(messageText),
        isTestMode: isTestMode,
        isChannelPost: isChannelPost, // Channel posts are higher risk - no user history
        channelTitle: isChannelPost ? senderInfo.title : null
      }

      let result
      try {
        result = await checkSpam(messageText, ctx, spamSettings)
      } catch (error) {
        spamLog.error({ userId: senderId, userName: userName(senderInfo), err: error.message }, 'Check failed')
        return false
      }

      // Handle null/undefined result (e.g., empty LLM response)
      if (!result) {
        spamLog.warn({ userId: senderId, userName: userName(senderInfo) }, 'No result - treating as clean')
        return false
      }

      // Log result with quick assessment info if available
      const logData = {
        isSpam: result.isSpam,
        confidence: result.confidence,
        source: result.source
      }

      // Include quick assessment in log if present
      if (result.quickAssessment) {
        logData.quickRisk = result.quickAssessment.risk
        if (result.quickAssessment.signals && result.quickAssessment.signals.length > 0) {
          logData.quickSignals = result.quickAssessment.signals
        }
      }

      spamLog.info(logData, result.isSpam ? 'SPAM detected' : 'CLEAN')

      if (isTestMode) {
        spamLog.info({
          text: messageText.substring(0, 100),
          classification: result.isSpam ? 'SPAM' : 'CLEAN',
          confidence: result.confidence,
          source: result.source,
          reason: result.reason
        }, 'TEST MODE - Details')
      }

      // Use dynamic confidence threshold and determine action
      const baseThreshold = spamSettings.confidenceThreshold || 70
      const action = determineAction(result, context, baseThreshold)

      if (action.action !== 'none') {
        const userDisplayName = context.userName
        const userId = context.userId
        const shortMessage = messageText.substring(0, 150)
        const displayMessage = messageText.length > 150 ? `${shortMessage}...` : shortMessage

        spamAction.warn({
          userId,
          userName: userDisplayName,
          action: action.action,
          source: result.source,
          message: displayMessage,
          reason: action.reason,
          confidence: result.confidence
        }, 'Taking action')

        // Get mute duration from action or default
        const muteDuration = action.duration || (senderInfo.is_premium ? 3600 : 86400)

        let muteSuccess = false
        let deleteSuccess = false

        // Check bot permissions once (avoid duplicate API calls)
        let canRestrictMembers = false
        let canDeleteMessages = false
        try {
          const botMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id)
          canRestrictMembers = botMember.can_restrict_members
          canDeleteMessages = botMember.can_delete_messages ||
                             (ctx.message.date && (Date.now() / 1000 - ctx.message.date) < 2 * 24 * 60 * 60)
        } catch (error) {
          spamAction.error({ err: error.message }, 'Failed to check bot permissions')
        }

        // Handle mute/restrict action
        if (action.action === 'mute_and_delete' || action.action === 'warn_and_restrict') {
          if (canRestrictMembers) {
            try {
              if (isChannelPost) {
                // For channels, use banChatSenderChat
                await ctx.telegram.callApi('banChatSenderChat', {
                  chat_id: ctx.chat.id,
                  sender_chat_id: senderId
                })
                muteSuccess = true
                spamAction.info({ channelTitle: senderInfo.title }, 'Banned channel')
              } else {
                // For users, use restrictChatMember
                await ctx.telegram.restrictChatMember(ctx.chat.id, senderId, {
                  can_send_messages: false,
                  can_send_media_messages: false,
                  can_send_other_messages: false,
                  can_add_web_page_previews: false,
                  until_date: Math.floor(Date.now() / 1000) + muteDuration
                })
                muteSuccess = true
                spamAction.info({ userName: userDisplayName, muteDuration }, 'Muted user')
              }
            } catch (error) {
              spamAction.error({ err: error.message, userName: userDisplayName, action: isChannelPost ? 'ban' : 'mute' }, 'Action failed')
            }
          } else {
            spamAction.error({ chatTitle: ctx.chat.title }, 'No restrict permission')
          }
        }

        // Handle delete action
        if (action.action === 'mute_and_delete' || action.action === 'delete_only' || action.action === 'warn_and_restrict') {
          if (canDeleteMessages) {
            try {
              await ctx.deleteMessage()
              deleteSuccess = true
              spamAction.info({ userName: userDisplayName }, 'Deleted message')
            } catch (error) {
              spamAction.error({ err: error.message, userName: userDisplayName, userId }, 'Failed to delete message')
            }
          } else {
            spamAction.error({ chatTitle: ctx.chat.title }, 'No delete permission')
          }
        }

        // Update global reputation stats and apply global ban if needed
        if (!isChannelPost && ctx.session && ctx.session.userInfo) {
          const spamResult = processSpamAction(ctx.session.userInfo, {
            userId: senderId,
            messageDeleted: deleteSuccess,
            confidence: result.confidence,
            reason: result.reason || 'AI-detected spam',
            muteSuccess: muteSuccess,
            globalBanEnabled: spamSettings.globalBan !== false
          })

          if (spamResult.statsUpdated) {
            repLog.debug({
              spamDetections: ctx.session.userInfo.globalStats.spamDetections,
              newScore: spamResult.newReputation ? spamResult.newReputation.score : 'N/A'
            }, 'Updated spam stats')
          }

          if (spamResult.globalBanApplied) {
            spamAction.warn({
              userId: senderId,
              userName: userDisplayName,
              reason: result.reason,
              confidence: result.confidence
            }, 'Global ban applied')
          }
        }

        // Save to knowledge base after successful action (higher confidence in spam classification)
        if (result.source === 'openrouter_llm' && result.confidence >= 75 && result.confidence < 90) {
          try {
            const embedding = await generateEmbedding(messageText)
            const features = extractFeatures(messageText, context)

            let adjustedConfidence = result.confidence / 100

            // Increase confidence if strong action was taken (mute + delete)
            if (muteSuccess && deleteSuccess) {
              adjustedConfidence = Math.min(0.95, adjustedConfidence + 0.1) // Boost by 10%
            } else if (muteSuccess || deleteSuccess) {
              adjustedConfidence = Math.min(0.9, adjustedConfidence + 0.05) // Boost by 5%
            }

            if (embedding) {
              await saveSpamVector({
                text: messageText,
                embedding,
                classification: result.isSpam ? 'spam' : 'clean',
                confidence: adjustedConfidence,
                features
              })
              spamAction.debug({ confidence: (adjustedConfidence * 100).toFixed(1) }, 'Saved vector with boosted confidence')
            }
          } catch (saveError) {
            spamAction.error({ err: saveError.message }, 'Failed to save confirmed pattern')
          }
        }

        // Send notification
        let statusMessage = ''
        const testModeLabel = isTestMode ? '\n🧪 TEST MODE' : ''
        const notificationParams = { name: userName(senderInfo, true), reason: result.reason }

        if (muteSuccess && deleteSuccess) {
          statusMessage = ctx.i18n.t('spam.notification.full', notificationParams) + testModeLabel
        } else if (muteSuccess && !deleteSuccess) {
          statusMessage = ctx.i18n.t('spam.notification.muted_only', notificationParams) + testModeLabel
        } else if (!muteSuccess && deleteSuccess) {
          statusMessage = ctx.i18n.t('spam.notification.deleted_only', notificationParams) + testModeLabel
        } else if (!muteSuccess && !deleteSuccess) {
          // Bot detected spam but has no permissions to act
          statusMessage = ctx.i18n.t('spam.notification.no_permissions', notificationParams) + testModeLabel
          notifyLog.warn('Spam detected but no permissions to act')
        }

        if (statusMessage) {
          const notificationMsg = await ctx.replyWithHTML(statusMessage, { disable_web_page_preview: true })
            .catch(error => notifyLog.error({ err: error.message }, 'Failed to send notification'))

          // Schedule notification message deletion
          if (notificationMsg) {
            const deleteDelay = (muteSuccess || deleteSuccess) ? 25 : 60 // longer for no-permission warnings
            notifyLog.debug({ deleteDelay }, 'Sent notification, will auto-delete')
            setTimeout(async () => {
              await ctx.telegram.deleteMessage(ctx.chat.id, notificationMsg.message_id)
                .catch(error => notifyLog.error({ err: error.message }, 'Failed to delete notification'))
              notifyLog.debug('Auto-deleted notification message')
            }, deleteDelay * 1000)
          }
        }

        return true // Stop further processing
      } else if (!result.isSpam && result.confidence >= 70) {
        // High confidence clean message - boost reputation
        if (ctx.session && ctx.session.userInfo) {
          const stats = ctx.session.userInfo.globalStats || (ctx.session.userInfo.globalStats = {})
          stats.cleanMessages = (stats.cleanMessages || 0) + 1
        }
      }
    }
  }

  return false // Continue processing
}
