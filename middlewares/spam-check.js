const { userName } = require('../utils')
const { checkSpam, checkTrustedUser, getSpamSettings, humanizeReason } = require('../helpers/spam-check')
const { saveSpamVector } = require('../helpers/spam-vectors')
const { generateEmbedding, extractFeatures } = require('../helpers/message-embeddings')
const { processSpamAction } = require('../helpers/reputation')
const { createVoteEvent, getAccountAgeDays } = require('../helpers/vote-ui')
const { addSignature } = require('../helpers/spam-signatures')
const { spam: spamLog, spamAction, reputation: repLog, notification: notifyLog } = require('../helpers/logger')
const { scheduleDeletion } = require('../helpers/message-cleanup')

/**
 * Determine if user should receive full ban (vs temporary mute)
 *
 * Full ban criteria (SAFE - only community-verified):
 * 1. Confirmed signature match (exact/normalized) - pattern verified by 3+ groups
 * 2. Community-confirmed repeat spammer - 2+ spam verdicts decided BY VOTES
 * 3. Restricted reputation status - already heavily penalized (score < 20)
 *
 * NOT triggers for ban (unsafe):
 * - High AI confidence alone
 * - spamDetections counter (includes unverified)
 * - Pending votes or timeout verdicts
 *
 * @returns {Object} { shouldBan: boolean, reason: string }
 */
const shouldFullBan = async (ctx, result, userId) => {
  // 1. Confirmed signature match = instant ban
  // These patterns were verified by 3+ different groups
  if (result.source && (
    result.source === 'spam_signature_exact' ||
    result.source === 'spam_signature_normalized'
  )) {
    return {
      shouldBan: true,
      reason: 'confirmed_signature'
    }
  }

  // 2. Community-confirmed repeat spammer
  // Only count verdicts decided BY VOTES (not timeout, not pending)
  if (ctx.db?.SpamVote) {
    try {
      const confirmedSpamVerdicts = await ctx.db.SpamVote.countDocuments({
        bannedUserId: userId,
        result: 'spam',
        resolvedBy: 'votes' // Community decided, not timeout
      })

      if (confirmedSpamVerdicts >= 2) {
        return {
          shouldBan: true,
          reason: 'community_confirmed_spammer'
        }
      }
    } catch (err) {
      spamAction.warn({ err: err.message }, 'Failed to check spam verdicts')
    }
  }

  // 3. Already restricted by reputation system (score < 20)
  const reputation = ctx.session?.userInfo?.reputation
  if (reputation?.status === 'restricted') {
    return {
      shouldBan: true,
      reason: 'restricted_reputation'
    }
  }

  return { shouldBan: false, reason: null }
}

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
  // Handle both new messages and edited messages
  // Edited messages can be used to bypass spam detection (send clean, edit to spam)
  const message = ctx.message || ctx.editedMessage
  const isEditedMessage = !!ctx.editedMessage

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
  const senderChat = message && message.sender_chat
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
  if (!isTestMode && message && message.text && message.text.startsWith('/')) {
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
  const hasUserContent = message && (
    message.text ||
    message.caption ||
    message.photo ||
    message.video ||
    message.document ||
    message.audio ||
    message.voice ||
    message.video_note ||
    message.sticker ||
    message.animation
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

  // Check spam for:
  // 1. Users with member data (tracked group members)
  // 2. Channel posts (always check)
  // 3. Users WITHOUT member data (commenters, non-members) - important for discussion groups!
  const hasMemberData = ctx.group && ctx.group.members && ctx.group.members[senderId] && ctx.group.members[senderId].stats
  const isNonMember = !hasMemberData && !isChannelPost

  // Log non-member/commenter check
  if (isNonMember && shouldCheckSpam) {
    const isTopicMessage = message && message.is_topic_message
    spamLog.debug({
      userId: senderId,
      userName: userName(senderInfo),
      isTopicMessage: !!isTopicMessage
    }, 'Checking non-member/commenter')
  }

  // Non-members (commenters) should always be checked - they're unknown users
  if ((hasMemberData || isChannelPost || isNonMember) && shouldCheckSpam) {
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
        // Fallback: if we can't verify admin status, trust established users
        // High message count (>50) or good reputation (>70) = likely not a spammer
        const repScore = userReputation ? userReputation.score : 50
        if (messageCount > 50 || repScore > 70) {
          spamLog.debug({
            userId: senderId,
            userName: userName(senderInfo),
            messageCount,
            repScore,
            reason: 'admin_check_failed_but_established'
          }, 'Skipping established user (admin check failed)')
          return
        }
      }
    } else if (isTestMode) {
      spamLog.debug({ userId: senderId, userName: userName(senderInfo) }, 'TEST MODE - Bypassing admin check')
    }

    // Check message for spam
    if (message) {
      const originalText = message.text || message.caption || ''
      let messageText = originalText.trim()

      // Handle messages without text/caption
      if (!messageText) {
        if (message.sticker) {
          messageText = `[Sticker: ${message.sticker.emoji || 'unknown'}]`
        } else if (message.voice) {
          messageText = '[Voice message]'
        } else if (message.photo) {
          messageText = '[Photo]'
        } else if (message.document) {
          messageText = `[Document: ${message.document.file_name || 'unknown'}]`
        } else {
          messageText = '[Media message]'
        }
      }

      const actualMessageCount = hasMemberData ? ctx.group.members[senderId].stats.messagesCount : 0
      const senderType = isChannelPost ? 'channel' : (isNonMember ? 'non-member' : 'user')
      spamLog.info({
        senderType,
        userName: userName(senderInfo),
        userId: senderId,
        messageCount: isTestMode ? 'TEST' : (isChannelPost ? 'channel' : actualMessageCount),
        isEdited: isEditedMessage || undefined // Only log if true
      }, isEditedMessage ? 'Checking EDITED message' : 'Checking message')

      // Build context for spam check
      const isTopicMessage = message && message.is_topic_message
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
        channelTitle: isChannelPost ? senderInfo.title : null,
        // Non-member context (commenters in discussion groups)
        isNonMember: isNonMember,
        isTopicMessage: !!isTopicMessage,
        // Edited messages - could be spam added after initial clean message
        isEditedMessage: isEditedMessage
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
                             (message.date && (Date.now() / 1000 - message.date) < 2 * 24 * 60 * 60)
        } catch (error) {
          spamAction.error({ err: error.message }, 'Failed to check bot permissions')
        }

        // Handle mute/restrict action
        let fullBanApplied = false
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
                fullBanApplied = true
                spamAction.info({ channelTitle: senderInfo.title }, 'Banned channel')
              } else {
                // Check if user deserves full ban (vs temporary mute)
                const banDecision = await shouldFullBan(ctx, result, senderId)

                if (banDecision.shouldBan) {
                  // Full ban with message revocation
                  await ctx.telegram.callApi('banChatMember', {
                    chat_id: ctx.chat.id,
                    user_id: senderId,
                    revoke_messages: true
                  })
                  muteSuccess = true
                  fullBanApplied = true
                  spamAction.warn({
                    userName: userDisplayName,
                    reason: banDecision.reason
                  }, 'Full ban applied (messages revoked)')
                } else {
                  // Temporary mute
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

        // Create vote event for community moderation (only for uncertain cases)
        // High confidence (>=90%) = no voting needed, instant action
        const needsVoting = result.confidence < 90

        if ((muteSuccess || deleteSuccess) && needsVoting) {
          try {
            const voteEvent = await createVoteEvent(ctx, {
              result,
              actionTaken: {
                muteSuccess,
                deleteSuccess,
                muteDuration,
                fullBanApplied
              },
              messageText,
              userContext: {
                reputationScore: ctx.session?.userInfo?.reputation?.score,
                reputationStatus: ctx.session?.userInfo?.reputation?.status,
                accountAgeDays: getAccountAgeDays(senderId),
                messagesInGroup: actualMessageCount,
                groupsActive: ctx.session?.userInfo?.globalStats?.groupsActive || 0,
                signals: result.quickAssessment?.signals || []
              }
            })
            if (!voteEvent) {
              notifyLog.warn('Vote event creation returned null - missing sender info')
            }
          } catch (voteError) {
            notifyLog.error({ err: voteError.message }, 'Failed to create vote event')
          }
        } else if ((muteSuccess || deleteSuccess) && !needsVoting) {
          // High confidence - just show brief notification, no voting
          const notificationMsg = await ctx.replyWithHTML(
            ctx.i18n.t('spam.notification.full', { name: userName(senderInfo, true), reason: humanizeReason(result.reason, ctx.i18n) }),
            { disable_web_page_preview: true }
          ).catch(e => notifyLog.error({ err: e.message }, 'Failed to send high-confidence notification'))

          // Schedule auto-delete after 30 seconds (persistent)
          if (notificationMsg && ctx.db) {
            scheduleDeletion(ctx.db, {
              chatId: ctx.chat.id,
              messageId: notificationMsg.message_id,
              delayMs: 30000,
              source: 'spam_high_confidence'
            }, ctx.telegram)
          }

          // Add to signature database for high-confidence cases
          if (ctx.db) {
            addSignature(messageText, ctx.db, ctx.chat.id).catch(e =>
              notifyLog.error({ err: e.message }, 'Failed to add signature for high-confidence spam')
            )
          }

          notifyLog.info({ confidence: result.confidence, source: result.source }, 'High confidence spam - no voting')
        } else if (!muteSuccess && !deleteSuccess) {
          // Bot detected spam but has no permissions to act - show simple notification
          const notificationParams = { name: userName(senderInfo, true), reason: humanizeReason(result.reason, ctx.i18n) }
          const statusMessage = ctx.i18n.t('spam.notification.no_permissions', notificationParams)
          notifyLog.warn('Spam detected but no permissions to act')

          const notificationMsg = await ctx.replyWithHTML(statusMessage, { disable_web_page_preview: true })
            .catch(error => notifyLog.error({ err: error.message }, 'Failed to send notification'))

          // Schedule auto-delete after 60 seconds (persistent)
          if (notificationMsg && ctx.db) {
            scheduleDeletion(ctx.db, {
              chatId: ctx.chat.id,
              messageId: notificationMsg.message_id,
              delayMs: 60 * 1000,
              source: 'spam_no_permissions'
            }, ctx.telegram)
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
