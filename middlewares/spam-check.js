const { userName } = require('../utils')
const { checkSpam, checkTrustedUser, getSpamSettings } = require('../helpers/spam-check')
const { saveSpamPattern } = require('../helpers/spam-patterns')
const { generateEmbedding, extractFeatures } = require('../helpers/message-embeddings')

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
 */
const isLikelyNewAccount = (userId) => {
  if (userId > 7000000000) return true
  if (userId > 6000000000) return true
  if (userId > 5000000000) return true
  return false
}

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

  // Get the actual sender ID
  const senderId = (ctx.message && ctx.message.sender_chat && ctx.message.sender_chat.id) || ctx.from.id
  const senderInfo = (ctx.message && ctx.message.sender_chat) || ctx.from

  // Check if spam check is enabled for this group
  const spamSettings = getSpamSettings(ctx)
  if (!spamSettings || spamSettings.enabled === false) {
    console.log(`[SPAM CHECK] ⚙️ Spam check is disabled for group "${ctx.chat.title}"`)
    return false
  }

  // TEST MODE: Check if test mode is enabled (for development)
  const isTestMode = process.env.SPAM_TEST_MODE === 'true' ||
                     (ctx.message && ctx.message.text && ctx.message.text.includes('#testspam'))

  if (isTestMode) {
    console.log('[SPAM CHECK] 🧪 TEST MODE ENABLED - Bypassing all safety checks')
  }

  // Skip if message is a command (except in test mode)
  if (!isTestMode && ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) {
    return
  }

  // Skip if user ID is Telegram service notifications (777000) - except in test mode
  if (!isTestMode && senderId === 777000) {
    console.log('[SPAM CHECK] ⏭️ Skipping Telegram service message (ID 777000)')
    return
  }

  // Skip if user is in trusted whitelist - except in test mode
  if (!isTestMode && checkTrustedUser(senderId, ctx)) {
    console.log(`[SPAM CHECK] ⭐ Skipping trusted user ${userName(senderInfo)} (ID: ${senderId})`)
    return
  }

  // Check number of messages from the user (or force check in test mode)
  const messageCount = (ctx.group.members[senderId] && ctx.group.members[senderId].stats && ctx.group.members[senderId].stats.messagesCount) || 0
  const shouldCheckSpam = isTestMode || messageCount <= 5

  if (ctx.group &&
      ctx.group.members &&
      ctx.group.members[senderId] &&
      ctx.group.members[senderId].stats &&
      shouldCheckSpam
  ) {
    // Skip if user is an administrator (except in test mode)
    if (!isTestMode) {
      try {
        const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, senderId)
        if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
          console.log(`[SPAM CHECK] 👮 Skipping admin ${userName(senderInfo)} (ID: ${senderId})`)
          return
        }
      } catch (error) {
        console.log(`[SPAM CHECK] ⚠️ Could not check admin status for user ${senderId}: ${error.message}`)
      }
    } else {
      console.log('[SPAM CHECK] 🧪 TEST MODE - Bypassing admin check')
    }

    // Check message for spam
    if (ctx.message) {
      let originalText = ctx.message.text || ctx.message.caption || ''

      // Remove test mode hashtag before processing
      let messageText = originalText.replace(/#testspam/gi, '').trim()

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

      const actualMessageCount = ctx.group.members[senderId].stats.messagesCount
      const displayMessageCount = isTestMode ? '[TEST: ignored]' : actualMessageCount
      console.log(`[SPAM CHECK] 🔍 Checking user ${userName(senderInfo)} (ID: ${senderId}) with ${displayMessageCount} messages`)

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
        isTestMode: isTestMode
      }

      let result
      try {
        result = await checkSpam(messageText, ctx, spamSettings)
      } catch (error) {
        console.error(`[SPAM CHECK] ❌ Failed for ${userName(senderInfo)} (ID: ${senderId}): ${error.message}`)
        return false
      }

      console.log(`[SPAM CHECK] Result: ${result.isSpam ? '🚨 SPAM' : '✅ CLEAN'} (${result.confidence}%) - Source: ${result.source}`)

      if (isTestMode) {
        console.log('[SPAM CHECK] 🧪 TEST MODE - Message details:')
        console.log(`  📝 Original: "${originalText.substring(0, 100)}..."`)
        console.log(`  📝 Processed: "${messageText.substring(0, 100)}..."`)
        console.log(`  🤖 Classification: ${result.isSpam ? 'SPAM' : 'CLEAN'}`)
        console.log(`  📊 Confidence: ${result.confidence}%`)
        console.log(`  💾 Source: ${result.source}`)
        console.log(`  📄 Reason: ${result.reason}`)
      }

      // Use dynamic confidence threshold and determine action
      const baseThreshold = spamSettings.confidenceThreshold || 70
      const action = determineAction(result, context, baseThreshold)

      if (action.action !== 'none') {
        const userDisplayName = context.userName
        const userId = context.userId
        const shortMessage = messageText.substring(0, 150)
        const displayMessage = messageText.length > 150 ? `${shortMessage}...` : shortMessage

        console.log(`[SPAM ACTION] 🚨 Taking action against ${userDisplayName} (ID: ${userId})`)
        console.log(`[SPAM ACTION] 🔨 Action: ${action.action} | Source: ${result.source}`)
        console.log(`[SPAM ACTION] 💬 Message: "${displayMessage}"`)
        console.log(`[SPAM ACTION] 📝 Reason: ${action.reason} | 📊 Confidence: ${result.confidence}%`)

        // Get mute duration from action or default
        const muteDuration = action.duration || (senderInfo.is_premium ? 3600 : 86400)

        let muteSuccess = false
        let deleteSuccess = false

        // Check bot permissions before attempting to mute
        let canRestrictMembers = false
        try {
          const botMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id)
          canRestrictMembers = botMember.can_restrict_members
        } catch (error) {
          console.error(`[SPAM PERMISSIONS] ❌ Failed to check bot restrict permissions: ${error.message}`)
        }

        // Handle different action types
        if (action.action === 'mute_and_delete' || action.action === 'warn_and_restrict') {
          if (canRestrictMembers) {
            try {
              await ctx.telegram.restrictChatMember(
                ctx.chat.id,
                senderId,
                {
                  can_send_messages: false,
                  can_send_media_messages: false,
                  can_send_other_messages: false,
                  can_add_web_page_previews: false,
                  until_date: Math.floor(Date.now() / 1000) + muteDuration
                }
              )
              muteSuccess = true
              console.log(`[SPAM ACTION] ✅ Successfully muted ${userDisplayName} for ${muteDuration}s`)
            } catch (error) {
              console.error(`[SPAM ACTION] ❌ Failed to mute ${userDisplayName} (ID: ${userId}): ${error.message}`)
            }
          } else {
            console.error(`[SPAM ACTION] ❌ Bot lacks permission to restrict members in "${ctx.chat.title}"`)
          }
        }

        // Check if bot can delete messages
        let canDeleteMessages = false
        try {
          const botMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id)
          canDeleteMessages = botMember.can_delete_messages ||
                             (ctx.message.date && (Date.now() / 1000 - ctx.message.date) < 2 * 24 * 60 * 60)
        } catch (error) {
          console.error(`[SPAM PERMISSIONS] ❌ Failed to check delete permissions: ${error.message}`)
        }

        // Delete the message based on action type
        if (action.action === 'mute_and_delete' || action.action === 'delete_only' || action.action === 'warn_and_restrict') {
          if (canDeleteMessages) {
            try {
              await ctx.deleteMessage()
              deleteSuccess = true
              console.log(`[SPAM ACTION] ✅ Successfully deleted message from ${userDisplayName}`)
            } catch (error) {
              console.error(`[SPAM ACTION] ❌ Failed to delete message from ${userDisplayName} (ID: ${userId}): ${error.message}`)
            }
          } else {
            console.error(`[SPAM ACTION] ❌ Bot lacks permission to delete messages in "${ctx.chat.title}"`)
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
              await saveSpamPattern({
                text: messageText,
                embedding,
                classification: result.isSpam ? 'spam' : 'clean',
                confidence: adjustedConfidence,
                features
              })
              console.log(`[SPAM ACTION] Saved pattern with boosted confidence: ${(adjustedConfidence * 100).toFixed(1)}%`)
            }
          } catch (saveError) {
            console.error('[SPAM ACTION] Failed to save confirmed pattern:', saveError.message)
          }
        }

        // Send success notification
        if (muteSuccess || deleteSuccess) {
          let statusMessage = ''

          const testModeLabel = isTestMode ? '\n🧪 TEST MODE' : ''

          if (muteSuccess && deleteSuccess) {
            statusMessage = `🤖 Spam detected by AI system${testModeLabel}\n👤 User: ${userName(senderInfo, true)}\n📊 Confidence: ${result.confidence}%\n🔍 Source: ${result.source}\n📝 Reason: ${result.reason}`
          } else if (muteSuccess && !deleteSuccess) {
            statusMessage = `🤖 User muted by AI system${testModeLabel}\n👤 User: ${userName(senderInfo, true)}\n📊 Confidence: ${result.confidence}%\n🔍 Source: ${result.source}\n⚠️ Could not delete the message`
          } else if (!muteSuccess && deleteSuccess) {
            statusMessage = `🤖 Spam message deleted by AI${testModeLabel}\n📊 Confidence: ${result.confidence}%\n🔍 Source: ${result.source}\n⚠️ Could not mute ${userName(senderInfo, true)}`
          }

          const notificationMsg = await ctx.replyWithHTML(statusMessage)
            .catch(error => console.error(`[SPAM NOTIFICATION] ❌ Failed to send notification: ${error.message}`))

          // Schedule notification message deletion
          if (notificationMsg) {
            console.log(`[SPAM NOTIFICATION] 📨 Sent spam action notification, will auto-delete in 25s`)
            setTimeout(async () => {
              await ctx.telegram.deleteMessage(ctx.chat.id, notificationMsg.message_id)
                .catch(error => console.error(`[SPAM NOTIFICATION] ❌ Failed to delete notification: ${error.message}`))
              console.log(`[SPAM NOTIFICATION] 🗑️ Auto-deleted notification message`)
            }, 25 * 1000)
          }
        }

        return true // Stop further processing
      }
    }
  }

  return false // Continue processing
}
