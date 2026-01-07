const { OpenAI } = require('openai')
const {
  extractFeatures,
  generateEmbedding,
  getAdaptiveThreshold
} = require('./message-embeddings')
const {
  saveSpamVector,
  classifyBySimilarity,
  cleanupOldVectors,
  mergeSimilarVectors
} = require('./spam-vectors')
const {
  isNewAccount,
  getAccountAge
} = require('./account-age')
const {
  calculateVelocityScore
} = require('./velocity')
const { spam: spamLog, moderation: modLog, cleanup: cleanupLog, qdrant: qdrantLog } = require('./logger')

// Create OpenRouter client for LLM
const openRouter = new OpenAI({
  baseURL: process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY
})

// Create OpenAI client for moderation
const openAI = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

// Schedule cleanup tasks on startup
let cleanupInitialized = false
const initializeCleanup = () => {
  if (!cleanupInitialized) {
    setInterval(async () => {
      try {
        const cleanedCount = await cleanupOldVectors()
        const mergedCount = await mergeSimilarVectors()
        if (cleanedCount > 0 || mergedCount > 0) {
          cleanupLog.info({ cleaned: cleanedCount, merged: mergedCount }, 'Vector cleanup completed')
        }
      } catch (err) {
        cleanupLog.error({ err }, 'Error during cleanup')
      }
    }, 24 * 60 * 60 * 1000) // Daily cleanup
    cleanupInitialized = true
  }
}

/**
 * Check if user is in trusted whitelist
 */
const isTrustedUser = (userId, groupSettings) => {
  if (!groupSettings || !groupSettings.trustedUsers) return false
  return groupSettings.trustedUsers.includes(userId)
}

/**
 * Check if user has user profile (bio, photo, etc)
 */
const hasUserProfile = (ctx) => {
  const user = ctx.from
  return !!(user && (user.username || user.is_premium))
}

/**
 * Calculate dynamic threshold for LLM - Professional approach to minimize false positives
 */
const calculateDynamicThreshold = (context, groupSettings) => {
  let baseThreshold = (groupSettings && groupSettings.confidenceThreshold) || 75 // Increased from 70

  // More conservative approach for new accounts
  if (context.isNewAccount && context.messageCount <= 1) {
    baseThreshold -= 10 // Reduced from -20
  }

  if (context.messageCount <= 1 && !context.isNewAccount) {
    baseThreshold -= 5 // Reduced from -15
  }

  // Trust indicators
  if (context.isPremium) baseThreshold += 20 // Increased from 15
  if (context.hasProfile) baseThreshold += 15 // Increased from 10
  if (context.hasUsername) baseThreshold += 10 // Increased from 5
  if (context.messageCount > 10) baseThreshold += 15 // Increased from 10

  // Account age matters
  if (context.accountAge === 'established') baseThreshold += 10
  if (context.accountAge === 'very_new') baseThreshold -= 5

  // Global reputation adjustment
  if (context.globalReputation) {
    const rep = context.globalReputation
    if (rep.status === 'trusted') {
      // Safety net - should be skipped earlier
      baseThreshold += 25
    } else if (rep.status === 'neutral' && rep.score > 60) {
      // Good reputation neutral users get bonus
      baseThreshold += Math.floor((rep.score - 50) / 5) * 2 // +2 to +10
    } else if (rep.status === 'suspicious') {
      // Lower threshold for suspicious users
      baseThreshold -= 10
    } else if (rep.status === 'restricted') {
      // Very aggressive for restricted users
      baseThreshold -= 20
    }
  }

  // Telegram Stars rating adjustment
  if (context.telegramRating) {
    const level = context.telegramRating.level || 0
    if (level > 0) {
      // Positive level = trusted buyer, less likely to be spammer
      baseThreshold += Math.min(15, level * 5) // +5 to +15
    } else if (level < 0) {
      // Negative level = suspicious account
      baseThreshold -= 10
    }
  }

  // Adjusted bounds - lower floor to 50 for restricted users
  return Math.max(50, Math.min(95, baseThreshold))
}

/**
 * Get message photo URL for moderation
 */
const getMessagePhotoUrl = async (ctx, messagePhoto) => {
  try {
    if (!messagePhoto || !messagePhoto.file_id) return null

    const fileLink = await ctx.telegram.getFileLink(messagePhoto.file_id)
    return fileLink
  } catch (error) {
    modLog.error({ err: error.message }, 'Error getting message photo')
    return null
  }
}

/**
 * Get user profile photo URL for moderation
 */
const getUserProfilePhotoUrl = async (ctx) => {
  try {
    if (!ctx.from || !ctx.from.id) return null

    const userProfilePhotos = await ctx.telegram.getUserProfilePhotos(ctx.from.id, 0, 1)
    if (!userProfilePhotos.photos || userProfilePhotos.photos.length === 0) {
      return null
    }

    const photo = userProfilePhotos.photos[0][0] // Get the smallest size for moderation
    const fileLink = await ctx.telegram.getFileLink(photo.file_id)
    return fileLink
  } catch (error) {
    modLog.error({ err: error.message }, 'Error getting user profile photo')
    return null
  }
}

/**
 * Get user info from Telegram getChat API (bio + rating)
 */
const getUserChatInfo = async (ctx) => {
  try {
    if (!ctx.from || !ctx.from.id) return { bio: null, rating: null }

    const chatInfo = await ctx.telegram.getChat(ctx.from.id)
    return {
      bio: chatInfo.bio || null,
      rating: chatInfo.rating || null // UserRating object: { level, rating, current_level_rating, next_level_rating }
    }
  } catch (error) {
    modLog.error({ err: error.message }, 'Error getting user chat info')
    return { bio: null, rating: null }
  }
}

// Legacy alias
const getUserBio = async (ctx) => {
  const info = await getUserChatInfo(ctx)
  return info.bio
}

/**
 * Get group description from Telegram getChat API
 */
const getGroupDescription = async (ctx) => {
  try {
    if (!ctx.chat || !ctx.chat.id) return null

    const chatInfo = await ctx.telegram.getChat(ctx.chat.id)
    return chatInfo.description || null
  } catch (error) {
    modLog.error({ err: error.message }, 'Error getting group description')
    return null
  }
}

/**
 * Check message content using OpenAI moderation API
 * Only flags content for categories relevant to Telegram group moderation
 */
const checkOpenAIModeration = async (messageText, imageUrl = null, imageType = 'unknown') => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      modLog.debug('OpenAI API key not configured, skipping moderation check')
      return null
    }

    const input = []

    // Add text if present
    if (messageText && messageText.trim()) {
      input.push({ type: 'text', text: messageText })
    }

    // Add single image if provided
    if (imageUrl) {
      input.push({
        type: 'image_url',
        image_url: {
          url: imageUrl
        }
      })
      modLog.debug({ imageType }, 'Adding image to moderation check')
    }

    if (input.length === 0) {
      return null
    }

    const response = await openAI.moderations.create({
      model: 'omni-moderation-latest',
      input: input.length === 1 ? input[0].text : input
    })

    const result = response.results[0]

    // Whitelist only relevant categories for Telegram moderation
    const relevantCategories = [
      'sexual',
      'sexual/minors'
    ]

    // Filter flagged categories to only include relevant ones
    const flaggedCategories = Object.entries(result.categories)
      .filter(([category, flagged]) => flagged && relevantCategories.includes(category))
      .map(([category, _]) => category)

    if (flaggedCategories.length > 0) {
      // Get highest score only from relevant categories
      const relevantScores = Object.entries(result.category_scores)
        .filter(([category, _]) => relevantCategories.includes(category))
        .map(([_, score]) => score)

      const highestScore = Math.max(...relevantScores)

      modLog.warn({ categories: flaggedCategories, highestScore: (highestScore * 100).toFixed(1) }, 'Content flagged')

      return {
        flagged: true,
        categories: flaggedCategories,
        highestScore: highestScore * 100,
        reason: `Inappropriate content: ${flaggedCategories.join(', ')}`
      }
    }

    modLog.debug({ textLength: messageText ? messageText.length : 0, hasImage: !!imageUrl }, 'Content passed moderation')
    return { flagged: false }
  } catch (error) {
    modLog.error({ err: error.message }, 'Error during moderation check')
    return null
  }
}

/**
 * Main spam check function using hybrid approach
 */
const checkSpam = async (messageText, ctx, groupSettings) => {
  try {
    // Initialize cleanup on first run
    initializeCleanup()

    // Check with OpenAI moderation first - if flagged, treat as high-priority spam
    const messagePhoto = ctx.message && ctx.message.photo && ctx.message.photo[0] ? ctx.message.photo[0] : null

    // Fetch additional context in parallel
    const [userAvatarUrl, userChatInfo, groupDescription] = await Promise.all([
      getUserProfilePhotoUrl(ctx),
      getUserChatInfo(ctx),
      getGroupDescription(ctx)
    ])
    const userBio = userChatInfo.bio
    const userRating = userChatInfo.rating // { level, rating, current_level_rating, next_level_rating } or null

    // Check text content first
    const textModerationResult = await checkOpenAIModeration(messageText, null, 'text')
    if (textModerationResult && textModerationResult.flagged) {
      spamLog.warn({ reason: textModerationResult.reason }, 'Text flagged by OpenAI moderation')
      return {
        isSpam: true,
        confidence: Math.max(90, textModerationResult.highestScore),
        reason: textModerationResult.reason,
        source: 'openai_moderation_text',
        categories: textModerationResult.categories
      }
    }

    // Check message photo if present
    if (messagePhoto && messagePhoto.file_id) {
      const messagePhotoUrl = await getMessagePhotoUrl(ctx, messagePhoto)
      if (messagePhotoUrl) {
        const photoModerationResult = await checkOpenAIModeration(messageText, messagePhotoUrl, 'message photo')
        if (photoModerationResult && photoModerationResult.flagged) {
          spamLog.warn({ reason: photoModerationResult.reason }, 'Message photo flagged')
          return {
            isSpam: true,
            confidence: Math.max(90, photoModerationResult.highestScore),
            reason: photoModerationResult.reason,
            source: 'openai_moderation_photo',
            categories: photoModerationResult.categories
          }
        }
      }
    }

    // Check user avatar if present
    if (userAvatarUrl) {
      const avatarModerationResult = await checkOpenAIModeration(messageText, userAvatarUrl, 'user avatar')
      if (avatarModerationResult && avatarModerationResult.flagged) {
        spamLog.warn({ reason: avatarModerationResult.reason }, 'User avatar flagged')
        return {
          isSpam: true,
          confidence: Math.max(90, avatarModerationResult.highestScore),
          reason: avatarModerationResult.reason,
          source: 'openai_moderation_avatar',
          categories: avatarModerationResult.categories
        }
      }
    }

    // Get message counts from actual data sources
    // Check if this is a channel post
    const senderChat = ctx.message && ctx.message.sender_chat
    const isChannelPost = senderChat && senderChat.type === 'channel'
    const senderId = isChannelPost ? senderChat.id : (ctx.from && ctx.from.id)

    const perGroupMessageCount = ctx.group && ctx.group.members && senderId &&
      ctx.group.members[senderId] && ctx.group.members[senderId].stats &&
      ctx.group.members[senderId].stats.messagesCount
    const globalMessageCount = ctx.session && ctx.session.userInfo &&
      ctx.session.userInfo.globalStats && ctx.session.userInfo.globalStats.totalMessages
    const globalStats = (ctx.session && ctx.session.userInfo && ctx.session.userInfo.globalStats) || {}

    // Create user context for analysis
    const userContext = {
      isNewAccount: isChannelPost ? true : isNewAccount(ctx), // Treat channels as "new" - no history
      isPremium: (ctx.from && ctx.from.is_premium) || false,
      hasUsername: isChannelPost ? !!(senderChat.username) : !!(ctx.from && ctx.from.username),
      hasProfile: isChannelPost ? false : hasUserProfile(ctx),
      messageCount: perGroupMessageCount || 0,
      globalMessageCount: isChannelPost ? 0 : (globalMessageCount || 0), // No global stats for channels
      groupsActive: isChannelPost ? 0 : (globalStats.groupsActive || 0),
      previousWarnings: globalStats.spamDetections || 0,
      accountAge: isChannelPost ? 'unknown' : getAccountAge(ctx),
      // Global reputation from cross-group tracking
      globalReputation: isChannelPost
        ? { score: 30, status: 'suspicious' } // Channels start with lower trust
        : (ctx.session && ctx.session.userInfo && ctx.session.userInfo.reputation) || { score: 50, status: 'neutral' },
      // Telegram Stars rating (higher = more trusted buyer)
      telegramRating: userRating, // { level, rating } or null
      // Channel-specific info
      isChannelPost: isChannelPost,
      channelTitle: isChannelPost ? senderChat.title : null,
      channelUsername: isChannelPost ? senderChat.username : null
    }

    // Velocity check - detect cross-chat spam patterns
    // Use senderId (which handles channel posts correctly)
    try {
      if (!senderId || !ctx.chat || !ctx.chat.id || !ctx.message) {
        throw new Error('Missing context for velocity check')
      }
      const velocityResult = await calculateVelocityScore(
        messageText,
        senderId, // Use senderId instead of ctx.from.id for channel support
        ctx.chat.id,
        ctx.message.message_id
      )

      if (velocityResult.score > 0) {
        spamLog.debug({ velocityScore: (velocityResult.score * 100).toFixed(1), dominant: velocityResult.dominant }, 'Velocity score')
      }

      // High velocity = definite spam (cross-chat spam detected)
      if (velocityResult.score >= 0.8) {
        spamLog.warn({ reason: velocityResult.recommendation.reason }, 'High velocity spam detected')
        return {
          isSpam: true,
          confidence: velocityResult.recommendation.confidence,
          reason: velocityResult.recommendation.reason,
          source: 'velocity',
          velocitySignals: velocityResult.signals
        }
      }

      // Medium velocity = boost other spam signals
      if (velocityResult.score >= 0.4) {
        userContext.velocityBoost = velocityResult.score * 20 // Up to +8% boost
        userContext.velocityReason = velocityResult.dominant
      }
    } catch (velocityError) {
      spamLog.error({ err: velocityError.message }, 'Velocity check error')
    }

    // Extract features from message
    const features = extractFeatures(messageText, userContext)

    // Generate embedding for the message with context
    const hasCaption = messageText !== ctx.message.text && !!ctx.message.caption
    const embedding = await generateEmbedding(messageText, {
      isNewAccount: userContext.isNewAccount,
      messageCount: userContext.messageCount,
      hasCaption
    })

    if (embedding) {
      // Try to classify using local database first
      const localResult = await classifyBySimilarity(embedding)

      if (localResult) {
        qdrantLog.debug({ classification: localResult.classification, confidence: (localResult.confidence * 100).toFixed(1) }, 'Qdrant match found')

        // If confidence is high enough, return local result
        const adaptiveThreshold = getAdaptiveThreshold(features)
        qdrantLog.debug({ threshold: (adaptiveThreshold * 100).toFixed(1) }, 'Adaptive threshold')

        if (localResult.confidence >= adaptiveThreshold) {
          qdrantLog.info({ confidence: (localResult.confidence * 100).toFixed(1), threshold: (adaptiveThreshold * 100).toFixed(1) }, 'Using Qdrant result')
          return {
            isSpam: localResult.classification === 'spam',
            confidence: localResult.confidence * 100,
            reason: `Vector match: ${localResult.classification}`,
            source: 'qdrant_db'
          }
        } else {
          qdrantLog.debug({ confidence: (localResult.confidence * 100).toFixed(1), threshold: (adaptiveThreshold * 100).toFixed(1) }, 'Qdrant confidence too low, checking with LLM')
        }
      }
    }

    // Calculate dynamic threshold for LLM check
    const dynamicThreshold = calculateDynamicThreshold(userContext, groupSettings)

    spamLog.debug({ threshold: dynamicThreshold, msgLength: messageText.length, hasLinks: userContext.links && userContext.links.length > 0 }, 'Fallback to OpenRouter LLM')

    // Prepare context for LLM
    const contextInfo = []
    if (ctx.chat && ctx.chat.title) contextInfo.push(`Group: "${ctx.chat.title}"`)
    if (groupDescription) contextInfo.push(`Topic: "${groupDescription.substring(0, 150)}"`)
    if (userContext.isChannelPost) {
      contextInfo.push(`Sender: Channel "${userContext.channelTitle || 'Unknown'}"`)
      if (userContext.channelUsername) contextInfo.push(`Channel: @${userContext.channelUsername}`)
    } else {
      const username = ctx.from && ctx.from.username
      if (username) contextInfo.push(`Username: @${username}`)
    }
    if (userContext.isPremium) contextInfo.push('Premium user: Yes')
    if (userContext.isNewAccount && !userContext.isChannelPost) contextInfo.push('New account: Yes')
    if (userContext.messageCount > 0) contextInfo.push(`Messages in group: ${userContext.messageCount}`)
    if (userContext.globalMessageCount > 0) contextInfo.push(`Total messages (all groups): ${userContext.globalMessageCount}`)
    if (userContext.groupsActive > 1) contextInfo.push(`Active in ${userContext.groupsActive} groups`)
    if (userContext.globalReputation && userContext.globalReputation.score !== 50) {
      contextInfo.push(`Reputation: ${userContext.globalReputation.score}/100 (${userContext.globalReputation.status})`)
    }
    if (userContext.telegramRating) {
      const level = userContext.telegramRating.level
      if (level > 0) {
        contextInfo.push(`Telegram Stars buyer (level ${level}) - trusted`)
      } else if (level < 0) {
        contextInfo.push(`Telegram rating: negative (level ${level})`)
      }
    }
    if (userBio && userBio.trim()) contextInfo.push(`User bio: "${userBio.trim()}"`)
    if (ctx.message && ctx.message.quote && ctx.message.quote.text) {
      contextInfo.push(`Quoted text: "${ctx.message.quote.text.trim()}"`)
    }

    // Add regular reply info if present
    if (ctx.message && ctx.message.reply_to_message) {
      const replyTo = ctx.message.reply_to_message
      const replyInfo = []

      // Add info about the user being replied to
      if (replyTo.from) {
        const replyToUser = replyTo.from.username ? `@${replyTo.from.username}` : replyTo.from.first_name
        replyInfo.push(`Reply to: ${replyToUser}`)
      }

      // Add snippet of original message text if available (longer for better context)
      if (replyTo.text && replyTo.text.trim()) {
        const snippet = replyTo.text.trim().substring(0, 200)
        replyInfo.push(`Original message: "${snippet}${replyTo.text.length > 200 ? '...' : ''}"`)
      } else if (replyTo.caption && replyTo.caption.trim()) {
        const snippet = replyTo.caption.trim().substring(0, 200)
        replyInfo.push(`Original caption: "${snippet}${replyTo.caption.length > 200 ? '...' : ''}"`)
      }

      if (replyInfo.length > 0) {
        contextInfo.push(`Reply context: ${replyInfo.join(', ')}`)
      }
    }

    if (ctx.message && ctx.message.external_reply) {
      const externalReply = ctx.message.external_reply
      const replyInfo = []

      // Add origin information
      if (externalReply.origin) {
        if (externalReply.origin.type === 'user' && externalReply.origin.sender_user) {
          replyInfo.push(`Reply to user: @${externalReply.origin.sender_user.username || externalReply.origin.sender_user.first_name}`)
        } else if (externalReply.origin.type === 'channel' && externalReply.origin.chat) {
          replyInfo.push(`Reply to channel: ${externalReply.origin.chat.title || externalReply.origin.chat.username}`)
        } else if (externalReply.origin.type === 'chat' && externalReply.origin.sender_chat) {
          replyInfo.push(`Reply to chat: ${externalReply.origin.sender_chat.title}`)
        }
      }

      // Add chat info if available
      if (externalReply.chat && externalReply.chat.title) {
        replyInfo.push(`Original chat: "${externalReply.chat.title}"`)
      }

      if (replyInfo.length > 0) {
        contextInfo.push(`External reply: ${replyInfo.join(', ')}`)
      }
    }

    // Static system prompt (cacheable, no dynamic data)
    const systemPrompt = `Telegram group spam classifier. Output JSON: reasoning, classification (SPAM/CLEAN), confidence (0-100).

SPAM = unwanted commercial/scam content: ads, scams, phishing, service promotion, mass messaging.

NOT SPAM = normal human behavior: chatting, questions, jokes, trolling, rudeness, arguments, sharing links in context.

Key principle: offensive ≠ spam. Trolls and rude users are annoying but not spammers.
Trust users with history (messages, reputation, Stars rating).
When uncertain → CLEAN.`

    // Dynamic user prompt with all context
    const userPrompt = `${messageText}

---
${contextInfo.join(' | ')}`

    // Use OpenRouter for LLM analysis with structured output
    const response = await openRouter.chat.completions.create({
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'spam_analysis',
          schema: {
            type: 'object',
            properties: {
              reasoning: {
                type: 'string',
                description: 'Brief explanation of the classification'
              },
              classification: {
                type: 'string',
                enum: ['SPAM', 'CLEAN'],
                description: 'Whether the message is spam or clean'
              },
              confidence: {
                type: 'integer',
                minimum: 0,
                maximum: 100,
                description: 'Confidence level from 0 to 100'
              }
            },
            required: ['reasoning', 'classification', 'confidence'],
            additionalProperties: false
          }
        }
      },
      max_tokens: 1000
    })

    let analysis
    try {
      const content = response.choices[0].message.content
      if (!content) {
        throw new Error('Empty response content')
      }
      analysis = JSON.parse(content)
    } catch (parseError) {
      const rawContent = (response && response.choices && response.choices[0] && response.choices[0].message) ? response.choices[0].message.content : undefined
      spamLog.error({ err: parseError.message, rawContent }, 'JSON parsing error')
      return null // Return null to indicate parsing failure
    }

    const isSpam = analysis.classification === 'SPAM'
    let confidence = parseInt(analysis.confidence) || 70

    // Apply velocity boost if suspicious patterns detected
    if (isSpam && userContext.velocityBoost) {
      const boostedConfidence = Math.min(99, confidence + userContext.velocityBoost)
      spamLog.debug({ boost: userContext.velocityBoost.toFixed(1), reason: userContext.velocityReason }, 'Velocity boost applied')
      confidence = Math.round(boostedConfidence)
    }

    spamLog.info({ isSpam, confidence, source: 'openrouter_llm' }, 'OpenRouter result')

    // Save to knowledge base based on confidence and action taken
    if (embedding) {
      let shouldSave = false
      let saveConfidence = confidence / 100

      // High confidence from LLM - always save
      if (confidence >= 90) {
        shouldSave = true
      } else if (confidence >= 75) {
        // Medium confidence - save only if resulted in mute/ban (high certainty action)
        // We'll check this after actions are taken - move saving logic to middleware
        shouldSave = false // Don't save here, save in middleware after action
      } else if (!isSpam && confidence >= 85) {
        // Clean messages with high confidence - always save
        shouldSave = true
      }

      if (shouldSave) {
        try {
          await saveSpamVector({
            text: messageText,
            embedding,
            classification: isSpam ? 'spam' : 'clean',
            confidence: saveConfidence,
            features
          })
          qdrantLog.debug({ confidence }, 'Saved vector to Qdrant')
        } catch (saveError) {
          qdrantLog.error({ err: saveError.message }, 'Failed to save vector')
        }
      }
    }

    return {
      isSpam,
      confidence,
      reason: analysis.reasoning,
      source: 'openrouter_llm'
    }
  } catch (error) {
    spamLog.error({ err: error }, 'Error during spam check')
    return {
      isSpam: false,
      confidence: 0,
      reason: 'Error during analysis',
      source: 'error'
    }
  }
}

/**
 * Check spam settings for group
 */
const getSpamSettings = (ctx) => {
  if (!ctx.group || !ctx.group.info || !ctx.group.info.settings || !ctx.group.info.settings.openaiSpamCheck) return null
  return ctx.group.info.settings.openaiSpamCheck
}

/**
 * Check if user is trusted
 */
const checkTrustedUser = (userId, ctx) => {
  const settings = getSpamSettings(ctx)
  if (!settings) return false
  return isTrustedUser(userId, settings)
}

module.exports = {
  checkSpam,
  checkTrustedUser,
  getSpamSettings,
  checkOpenAIModeration,
  getUserProfilePhotoUrl,
  getMessagePhotoUrl,
  getUserBio
}
