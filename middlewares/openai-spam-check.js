const { OpenAI } = require('openai')
const { userName } = require('../utils')

// Create OpenAI client
const openai = new OpenAI({
  baseURL: process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY
})

/**
 * Check if user is in trusted whitelist
 * @param {Number} userId - User ID to check
 * @param {Object} groupSettings - Group spam check settings
 * @returns {Boolean} - True if user is trusted
 */
const isTrustedUser = (userId, groupSettings) => {
  if (!groupSettings || !groupSettings.trustedUsers) return false
  return groupSettings.trustedUsers.includes(userId)
}

/**
 * Get message frequency analysis for user
 * @param {Object} userStats - User statistics from database
 * @returns {Object} - Frequency analysis result
 */
const analyzeMessageFrequency = (userStats) => {
  if (!userStats) return { isRapidFire: false, messagesPerMinute: 0 }

  // This would need to be implemented with message timestamps in the database
  // For now, return conservative values
  return {
    isRapidFire: false,
    messagesPerMinute: 0,
    recentMessageCount: userStats.messagesCount || 0
  }
}

/**
 * Calculate dynamic confidence threshold based on user profile
 * @param {Object} context - User and message context
 * @param {Object} groupSettings - Group spam check settings
 * @returns {Number} - Adjusted confidence threshold
 */
const calculateDynamicThreshold = (context, groupSettings) => {
  let baseThreshold = (groupSettings && groupSettings.confidenceThreshold) || 70

  // Reduce threshold for highly suspicious indicators
  if (context.isNewAccount && context.messageCount <= 2) {
    baseThreshold -= 10
  }

  // Increase threshold for trusted indicators
  if (context.isPremium) baseThreshold += 15
  if (context.hasProfilePhoto) baseThreshold += 10
  if (context.hasUsername) baseThreshold += 5
  if (context.messageCount > 10) baseThreshold += 10

  // Ensure threshold stays within reasonable bounds
  return Math.max(50, Math.min(95, baseThreshold))
}

/**
 * Determine appropriate action based on spam confidence and user profile
 * @param {Object} result - Spam detection result
 * @param {Object} context - User context
 * @param {Number} threshold - Confidence threshold
 * @returns {Object} - Action to take
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
    return {
      action: 'delete_only',
      reason: result.reason
    }
  }

  return { action: 'none' }
}

/**
 * Checks message for spam or harmful content using OpenAI model
 * @param {String} text - text to check
 * @param {Object} context - additional context information
 * @returns {Promise<Object>} - result with isSpam flag and reason
 */
const checkSpam = async (text, context = {}) => {
  if (!text || text.length === 0) return { isSpam: false }

  try {
    // Build context information for the prompt
    const groupInfo = context.groupName ? `Group: "${context.groupName}"` : ''
    const userInfo = context.userName ? `User: ${context.userName}` : ''
    const userDetails = context.userDetails ? `User details: ${context.userDetails}` : ''
    const detailedUserInfo = context.detailedUserInfo ? `Detailed user info: ${context.detailedUserInfo}` : ''
    const userLanguage = context.languageCode ? `User language: ${context.languageCode}` : ''
    const isPremium = context.isPremium ? `Telegram Premium user: Yes` : ''
    const isNewAccount = context.isNewAccount ? `New account: Yes` : ''
    const repliedToInfo = context.repliedToMessage
      ? `Reply to message: "${context.repliedToMessage}"` : ''
    const userMessageCount = context.messageCount !== undefined
      ? `User message count: ${context.messageCount}` : ''
    const hasUsername = context.username ? `Username: @${context.username}` : 'No username'

    // Add message frequency analysis
    const frequencyInfo = context.messageFrequency
      ? `Message frequency: ${context.messageFrequency.messagesPerMinute}/min, Rapid fire: ${context.messageFrequency.isRapidFire}`
      : ''

    const contextInfo = [
      groupInfo,
      userInfo,
      userDetails,
      detailedUserInfo,
      hasUsername,
      userLanguage,
      isPremium,
      isNewAccount,
      userMessageCount,
      frequencyInfo,
      repliedToInfo
    ]
      .filter(item => item !== '')
      .join('\n')

    // Add custom rules to the prompt if they exist
    let customRulesPrompt = ''
    if (context.customRules && context.customRules.length > 0) {
      const allowRules = context.customRules
        .filter(rule => rule.toUpperCase().startsWith('ALLOW:'))
        .map(rule => `- ${rule.substring(6).trim()}`)

      const denyRules = context.customRules
        .filter(rule => rule.toUpperCase().startsWith('DENY:'))
        .map(rule => `- ${rule.substring(5).trim()}`)

      let allowPrompt = ''
      if (allowRules.length > 0) {
        allowPrompt = `

Group-specific ALLOW rules (do NOT flag messages that fall under these rules):
${allowRules.join('\n')}
`
      }

      let denyPrompt = ''
      if (denyRules.length > 0) {
        denyPrompt = `

Group-specific DENY rules (ALWAYS flag messages that fall under these rules as spam, even if they seem legitimate otherwise):
${denyRules.join('\n')}
`
      }
      customRulesPrompt = `${allowPrompt}${denyPrompt}`
    }

    // System instructions
    const systemPrompt = `You are a Telegram spam detection system. Your only job is to identify typical Telegram spam messages.

CRITICAL: Be extra cautious with borderline cases. When in doubt, err on the side of NOT flagging legitimate messages.

Focus ONLY on these common Telegram spam patterns:
1. Cryptocurrency/trading schemes: Promises of quick profits, investments, crypto signals
2. Dating/adult content solicitation: Links to dating sites, inappropriate services
3. Mass group invitations: Messages inviting users to other groups/channels without context
4. Fake giveaways: Free crypto, prizes requiring clicking suspicious links
5. Job scams: Unrealistic work-from-home offers, easy money schemes
6. Automated bot messages: Generic templates with suspicious links
7. Unauthorized promotions: Unsolicited advertising of services or products
8. Phishing attempts: Messages asking for personal data or Telegram credentials
9. Scam links: Suspicious shortened URLs or known malicious domains
10. Mass duplication: Identical messages posted across multiple groups

ENHANCED GUIDELINES for FALSE POSITIVE PREVENTION:
- Premium users are much less likely to be spammers - be more lenient
- Users with profile photos, usernames, and bio information are more legitimate
- Users with message history in the group (>5 messages) are less suspicious
- Messages replying to others in context are more likely legitimate
- Consider the group's language and culture - what seems spam in one context may be normal in another
- Generic greetings, questions, or normal conversation should NEVER be flagged
- Sharing personal opinions, experiences, or asking for help is legitimate
- Messages in the same language as the user's profile are more legitimate

Important: Do NOT flag:
- Normal conversations and questions
- Legitimate cryptocurrency discussions without promotional content
- Sharing personal experiences or opinions
- Asking for help or advice
- Regular links shared in conversation context
- Messages appropriate to the group topic
- Replies that are contextually relevant
- Greetings, introductions, or normal social interactions
${customRulesPrompt}

Rate your confidence from 0-100. Use confidence levels wisely:
- 90-100: Only for obvious spam with clear malicious intent
- 80-89: Strong spam indicators but not completely certain
- 70-79: Some spam indicators present
- 60-69: Borderline cases
- Below 60: Probably legitimate

Respond ONLY with this exact JSON format:
{
  "reason": "brief explanation (3-10 words)",
  "confidence": 0-100,
  "isSpam": true or false
}`

    // User message with specific content to analyze
    const userPrompt = `Analyze this message for spam:

Message:
"""
${text}
"""

Context information:
${contextInfo}`

    console.log(`[SPAM CHECK] Analyzing message: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`)

    const response = await openai.chat.completions.create({
      model: 'google/gemini-2.5-flash',
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
      max_tokens: 4000
    })

    try {
      const contentStr = response.choices[0].message.content.trim()
      // Use regex to extract JSON object from the response
      const jsonMatch = contentStr.match(/\{[\s\S]*\}/)
      const jsonStr = jsonMatch ? jsonMatch[0] : '{}'
      const result = JSON.parse(jsonStr)

      console.log(`[SPAM CHECK] Result: ${result.isSpam ? 'SPAM' : 'NOT SPAM'} - Reason: ${result.reason || 'Unspecified reason'} - Confidence: ${result.confidence || 'N/A'}%`)

      return {
        isSpam: result.isSpam,
        reason: result.reason || 'Unspecified reason',
        confidence: result.confidence || 0
      }
    } catch (parseError) {
      console.error('Failed to parse JSON response:', parseError)
      return { isSpam: false }
    }
  } catch (error) {
    console.error('OpenAI chat completion error:', error)
    return { isSpam: false }
  }
}

/**
 * Extract links from a message text
 * @param {String} text - Message text
 * @returns {Array} - Array of links
 */
const extractLinks = (text) => {
  if (!text) return []
  // URL regex pattern
  const urlRegex = /(https?:\/\/[^\s]+)|(t\.me\/[^\s]+)|(www\.[^\s]+)/gi
  return text.match(urlRegex) || []
}

/**
 * Check if user account is potentially new based on ID
 * Higher Telegram IDs tend to be newer accounts
 * @param {Number} userId - Telegram user ID
 * @returns {Boolean} - True if likely a new account
 */
const isLikelyNewAccount = (userId) => {
  // This is a very rough heuristic and may not be accurate
  // The specific threshold would need to be adjusted based on observation
  return userId > 6000000000 // Example threshold, adjust as needed
}

/**
 * Format user details string
 * @param {Object} user - Telegram user object
 * @returns {String} - Formatted user details
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
 * Get detailed user information using getChat method
 * @param {Object} telegram - Telegram bot instance
 * @param {Number} userId - User ID to get information about
 * @returns {Promise<Object>} - Detailed user information or null
 */
const getDetailedUserInfo = async (telegram, userId) => {
  try {
    const chatInfo = await telegram.getChat(userId)
    return chatInfo
  } catch (error) {
    // User might have privacy settings that prevent getting their info
    console.log(`[SPAM CHECK] Could not get detailed info for user ${userId}: ${error.message}`)
    return null
  }
}

/**
 * Extract relevant information from ChatFullInfo for spam analysis
 * @param {Object} chatInfo - ChatFullInfo object from getChat
 * @returns {Object} - Extracted user information
 */
const extractUserAnalysisInfo = (chatInfo) => {
  if (!chatInfo) return {}

  const info = {}

  // Basic information
  if (chatInfo.first_name) info.firstName = chatInfo.first_name
  if (chatInfo.last_name) info.lastName = chatInfo.last_name
  if (chatInfo.username) info.username = chatInfo.username
  if (chatInfo.bio) info.bio = chatInfo.bio

  // Account characteristics
  if (chatInfo.has_private_forwards) info.hasPrivateForwards = true
  if (chatInfo.has_restricted_voice_and_video_messages) info.hasRestrictedMedia = true

  // Profile customization (indicators of legitimate users)
  if (chatInfo.accent_color_id !== undefined) info.hasCustomAccentColor = true
  if (chatInfo.profile_accent_color_id !== undefined) info.hasCustomProfileColor = true
  if (chatInfo.emoji_status_custom_emoji_id) info.hasCustomEmojiStatus = true
  if (chatInfo.profile_background_custom_emoji_id) info.hasCustomProfileBackground = true

  // Personal channel (indicates more established user)
  if (chatInfo.personal_chat) info.hasPersonalChannel = true

  // Photo presence (legitimate users often have profile photos)
  if (chatInfo.photo) info.hasProfilePhoto = true

  return info
}

/**
 * Format detailed user information for spam analysis
 * @param {Object} userInfo - Extracted user information
 * @returns {String} - Formatted user information string
 */
const formatDetailedUserInfo = (userInfo) => {
  if (!userInfo || Object.keys(userInfo).length === 0) return ''

  const details = []

  if (userInfo.bio) details.push(`Bio: "${userInfo.bio}"`)
  if (userInfo.businessIntro) details.push(`Business intro: "${userInfo.businessIntro}"`)
  if (userInfo.hasBusinessLocation) details.push('Has business location')
  if (userInfo.hasBusinessHours) details.push('Has business hours')
  if (userInfo.hasPersonalChannel) details.push('Has personal channel')
  if (userInfo.hasProfilePhoto) details.push('Has profile photo')
  if (userInfo.hasCustomAccentColor) details.push('Custom accent color')
  if (userInfo.hasCustomProfileColor) details.push('Custom profile color')
  if (userInfo.hasCustomEmojiStatus) details.push('Custom emoji status')
  if (userInfo.hasCustomProfileBackground) details.push('Custom profile background')
  if (userInfo.hasPrivateForwards) details.push('Private forwards enabled')
  if (userInfo.hasRestrictedMedia) details.push('Restricted voice/video messages')

  return details.length > 0 ? details.join(', ') : ''
}

/**
 * Middleware for checking messages from new users for spam
 */
module.exports = async (ctx) => {
  // Skip if not in a group chat
  if (!ctx.chat || !['supergroup', 'group'].includes(ctx.chat.type)) {
    return
  }

  // Check if OpenAI spam check is enabled for this group
  if (ctx.group && ctx.group.info && ctx.group.info.settings && ctx.group.info.settings.openaiSpamCheck && ctx.group.info.settings.openaiSpamCheck.enabled === false) {
    console.log(`[SPAM CHECK] OpenAI spam check is disabled for group "${ctx.chat.title}"`)
    return false // Continue processing, but skip OpenAI check
  }

  // Skip if message is a command
  if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) {
    return
  }

  // Skip if user ID is Telegram service notifications (777000)
  if (ctx.from && ctx.from.id === 777000) {
    console.log('[SPAM CHECK] Skipping Telegram service message (ID 777000)')
    return
  }

  // Skip if user is an administrator
  const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id).catch(() => null)
  if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
    return
  }

  // Skip if message is from an anonymous admin (bot acting on behalf of a chat)
  if (ctx.from && ctx.from.is_bot && ctx.sender_chat) {
    return
  }

  // Skip if user is in trusted whitelist
  const spamSettings = ctx.group && ctx.group.info && ctx.group.info.settings && ctx.group.info.settings.openaiSpamCheck
  if (spamSettings && isTrustedUser(ctx.from.id, spamSettings)) {
    console.log(`[SPAM CHECK] Skipping trusted user ${userName(ctx.from)} (ID: ${ctx.from.id})`)
    return
  }

  // Check number of messages from the user
  if (ctx.group &&
      ctx.group.members &&
      ctx.group.members[ctx.from.id] &&
      ctx.group.members[ctx.from.id].stats &&
      ctx.group.members[ctx.from.id].stats.messagesCount <= 5) {
    // Check message for spam
    if (ctx.message && (ctx.message.text || ctx.message.caption)) {
      const messageText = ctx.message.text || ctx.message.caption
      console.log(`[SPAM CHECK] Checking message from ${userName(ctx.from)} (messages: ${ctx.group.members[ctx.from.id].stats.messagesCount})`)

      // Get detailed user information
      const detailedUserInfo = await getDetailedUserInfo(ctx.telegram, ctx.from.id)
      const extractedUserInfo = extractUserAnalysisInfo(detailedUserInfo)
      const detailedUserInfoString = formatDetailedUserInfo(extractedUserInfo)

      // Get reply message if exists
      let repliedToMessage = null
      if (ctx.message.reply_to_message) {
        repliedToMessage = ctx.message.reply_to_message.text ||
                          ctx.message.reply_to_message.caption ||
                          'Media message without text'
      }

      // Extract links from message
      const links = extractLinks(messageText)

      // Check if likely a new account
      const isNewAccount = isLikelyNewAccount(ctx.from.id)

      // Format user details
      const userDetails = formatUserDetails(ctx.from)

      // Build context object
      const context = {
        groupName: ctx.chat.title,
        userName: userName(ctx.from),
        userDetails: userDetails,
        detailedUserInfo: detailedUserInfoString,
        languageCode: ctx.from.language_code,
        isPremium: ctx.from.is_premium,
        isNewAccount: isNewAccount,
        username: ctx.from.username,
        messageCount: ctx.group.members[ctx.from.id].stats.messagesCount,
        repliedToMessage: repliedToMessage,
        links: links,
        customRules: (ctx.group && ctx.group.info && ctx.group.info.settings && ctx.group.info.settings.openaiSpamCheck && ctx.group.info.settings.openaiSpamCheck.customRules) || [],
        messageFrequency: analyzeMessageFrequency(ctx.group.members[ctx.from.id].stats)
      }

      const result = await checkSpam(messageText, context)

      // Use dynamic confidence threshold and determine appropriate action
      const confidenceThreshold = calculateDynamicThreshold(context, ctx.group.info.settings)
      const action = determineAction(result, context, confidenceThreshold)

      if (action.action !== 'none') {
        console.log(`[SPAM ACTION] User ${userName(ctx.from)} (ID: ${ctx.from.id}) - Action: ${action.action}`)
        console.log(`[SPAM ACTION] Message: "${messageText.substring(0, 150)}${messageText.length > 150 ? '...' : ''}"`)
        console.log(`[SPAM ACTION] Reason: ${action.reason} (Confidence: ${result.confidence || 'N/A'}%)`)

        // Get mute duration from action or default
        const muteDuration = action.duration || (ctx.from.is_premium ? 3600 : 86400)

        let muteSuccess = false
        let deleteSuccess = false

        // Check bot permissions before attempting to mute
        let canRestrictMembers = false
        try {
          const botMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id)
          canRestrictMembers = botMember.can_restrict_members
        } catch (error) {
          console.error(`[PERMISSION CHECK] Failed to check bot permissions: ${error.message}`)
        }

        // Handle different action types
        if (action.action === 'mute_and_delete' || action.action === 'warn_and_restrict') {
          // Mute the user only if bot has permissions
          if (canRestrictMembers) {
            try {
              await ctx.telegram.restrictChatMember(
                ctx.chat.id,
                ctx.from.id,
                {
                  can_send_messages: false,
                  can_send_media_messages: false,
                  can_send_other_messages: false,
                  can_add_web_page_previews: false,
                  until_date: Math.floor(Date.now() / 1000) + muteDuration
                }
              )
              muteSuccess = true
            } catch (error) {
              console.error(`[MUTE ERROR] Failed to mute user: ${error.message}`)
              // Don't send error notification to avoid spam
            }
          } else {
            console.error(`[MUTE ERROR] Bot doesn't have permission to restrict members in chat ${ctx.chat.id}`)
          }
        }

        // Check if bot can delete messages before attempting
        let canDeleteMessages = false
        try {
          const botMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id)
          canDeleteMessages = botMember.can_delete_messages ||
                             (ctx.message.date && (Date.now() / 1000 - ctx.message.date) < 2 * 24 * 60 * 60) // Can delete messages < 48h old
        } catch (error) {
          console.error(`[PERMISSION CHECK] Failed to check delete permissions: ${error.message}`)
        }

        // Delete the message based on action type
        if (action.action === 'mute_and_delete' || action.action === 'delete_only') {
          if (canDeleteMessages) {
            try {
              await ctx.deleteMessage()
              deleteSuccess = true
            } catch (error) {
              console.error(`[DELETE ERROR] Failed to delete message: ${error.message}`)
              // Don't send error notification to avoid spam
            }
          } else {
            console.error(`[DELETE ERROR] Bot doesn't have permission to delete messages in chat ${ctx.chat.id}`)
          }
        }

        // Send success notification only if at least one action succeeded
        if (muteSuccess || deleteSuccess) {
          let statusMessage = ''
          if (muteSuccess && deleteSuccess) {
            statusMessage = ctx.i18n.t('spam.muted', {
              name: userName(ctx.from, true),
              reason: result.reason
            })
            // Set global ban status
            if (ctx.session.userInfo) {
              // Check if global ban is enabled for this group
              const globalBanEnabled = ctx.group &&
                                     ctx.group.info &&
                                     ctx.group.info.settings &&
                                     ctx.group.info.settings.openaiSpamCheck &&
                                     ctx.group.info.settings.openaiSpamCheck.globalBan !== false

              if (globalBanEnabled) {
                ctx.session.userInfo.isGlobalBanned = true
                ctx.session.userInfo.globalBanReason = result.reason
                ctx.session.userInfo.globalBanDate = new Date()
                await ctx.session.userInfo.save().catch(err => console.error('[SPAM CHECK ERROR] Failed to save global ban status:', err))
                console.log(`[GLOBAL BAN] User ${userName(ctx.from)} (ID: ${ctx.from.id}) globally banned by AI. Reason: ${result.reason}`)
              } else {
                console.log(`[SPAM CHECK] Global ban skipped for group "${ctx.chat.title}" - globalBan setting is disabled`)
              }
            }
          } else if (muteSuccess && !deleteSuccess) {
            statusMessage = `✅ ${userName(ctx.from, true)} was muted for spam\nReason: ${result.reason}\n⚠️ Could not delete the message`
          } else if (!muteSuccess && deleteSuccess) {
            statusMessage = `✅ Spam message deleted\n⚠️ Could not mute ${userName(ctx.from, true)}\nReason: ${result.reason}`
          }

          const notificationMsg = await ctx.replyWithHTML(statusMessage)
            .catch(error => console.error(`[MUTE ERROR] Failed to send notification: ${error.message}`))

          // Schedule notification message deletion
          if (notificationMsg) {
            setTimeout(async () => {
              await ctx.telegram.deleteMessage(ctx.chat.id, notificationMsg.message_id)
                .catch(error => console.error(`[MUTE ERROR] Failed to delete notification after timeout: ${error.message}`))
              console.log(`[MUTE] Auto-deleted notification message after timeout`)
            }, 25 * 1000) // 25 seconds
          }
        }

        return true // Stop further processing
      }
    }
  }

  return false // Continue processing
}
