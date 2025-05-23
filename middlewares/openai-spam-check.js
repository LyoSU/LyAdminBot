const { OpenAI } = require('openai')
const { userName } = require('../utils')

// Create OpenAI client
const openai = new OpenAI({
  baseURL: process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY
})

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
      repliedToInfo
    ]
      .filter(item => item !== '')
      .join('\n')

    const prompt = `
You are a Telegram spam detection system. Your only job is to identify typical Telegram spam messages.

Message to analyze:
"""
${text}
"""

Context information:
${contextInfo}

Focus ONLY on these common Telegram spam patterns:
1. Cryptocurrency/trading schemes: Promises of quick profits, investments, crypto signals
2. Dating/adult content solicitation: Links to dating sites, inappropriate services
3. Mass group invitations: Messages inviting users to other groups/channels without context
4. Fake giveaways: Free crypto, prizes requiring clicking suspicious links
5. Job scams: Unrealistic work-from-home offers, easy money schemes
6. Automated bot messages: Generic templates with suspicious links
7. Unauthorized promotions: Unsolicited advertising of services or products
8. Phishing attempts: Messages asking for personal data or Telegram credentials
9. New accounts with suspicious behavior: New accounts posting promotional content
10. Bot-like communication patterns: Generic messages that appear automated

Important: Do NOT flag:
- Normal conversations
- Questions about cryptocurrencies without promotion
- Legitimate sharing of information
- Opinions or discussions
- Regular links shared in conversation
- Messages appropriate to the group context
- Messages from premium users (less likely to be spam)

Respond ONLY with this exact JSON format:
{
  "reason": "brief explanation (3-10 words)",
  "confidence": 0-100,
  "isSpam": true or false
}
`

    console.log(`[SPAM CHECK] Analyzing message: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`)

    const response = await openai.chat.completions.create({
      model: 'google/gemini-2.5-flash-preview-05-20',
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      // response_format: { type: 'json_object' },
      max_tokens: 150
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

  // Business account information (legitimate business users)
  if (chatInfo.business_intro) {
    info.isBusinessAccount = true
    info.businessIntro = chatInfo.business_intro.title || chatInfo.business_intro.message
  }
  if (chatInfo.business_location) info.hasBusinessLocation = true
  if (chatInfo.business_opening_hours) info.hasBusinessHours = true

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
  if (userInfo.isBusinessAccount) details.push('Business account')
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
        links: links
      }

      const result = await checkSpam(messageText, context)

      // Use confidence threshold if available
      const confidenceThreshold = 70 // Default threshold
      const isConfidentSpam = result.isSpam &&
                             (result.confidence === undefined ||
                              result.confidence >= confidenceThreshold)

      if (isConfidentSpam) {
        console.log(`[MUTE] User ${userName(ctx.from)} (ID: ${ctx.from.id}) muted for spam`)
        console.log(`[MUTE] Message: "${messageText.substring(0, 150)}${messageText.length > 150 ? '...' : ''}"`)
        console.log(`[MUTE] Reason: ${result.reason} (Confidence: ${result.confidence || 'N/A'}%)`)

        // Get mute duration - premium users get shorter mute time as they're less likely to be spammers
        const muteDuration = ctx.from.is_premium ? 3600 : 86400 // 1 hour for premium, 24 hours for regular

        // Mute the user
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
        ).catch(error => console.error(`[MUTE ERROR] Failed to mute user: ${error.message}`))

        // Delete the message
        await ctx.deleteMessage().catch(error => console.error(`[MUTE ERROR] Failed to delete message: ${error.message}`))

        // Send notification to the chat and delete it after 30 seconds
        const notificationMsg = await ctx.replyWithHTML(ctx.i18n.t('spam.muted', {
          name: userName(ctx.from, true),
          reason: result.reason
        })).catch(error => console.error(`[MUTE ERROR] Failed to send notification: ${error.message}`))

        // Schedule notification message deletion
        if (notificationMsg) {
          setTimeout(async () => {
            await ctx.telegram.deleteMessage(ctx.chat.id, notificationMsg.message_id)
              .catch(error => console.error(`[MUTE ERROR] Failed to delete notification after timeout: ${error.message}`))
            console.log(`[MUTE] Auto-deleted notification message after timeout`)
          }, 25 * 1000) // 25 seconds
        }

        return true // Stop further processing
      }
    }
  }

  return false // Continue processing
}
