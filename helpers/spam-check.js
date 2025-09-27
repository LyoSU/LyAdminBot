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
          console.log(`[CLEANUP] Removed ${cleanedCount} old vectors, merged ${mergedCount} similar vectors`)
        }
      } catch (err) {
        console.error('[CLEANUP] Error during cleanup:', err)
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

  // More conservative bounds - no actions below 60%
  return Math.max(60, Math.min(95, baseThreshold))
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
    console.error('[MODERATION] Error getting message photo:', error.message)
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
    console.error('[MODERATION] Error getting user profile photo:', error.message)
    return null
  }
}

/**
 * Get user bio from Telegram getChat API
 */
const getUserBio = async (ctx) => {
  try {
    if (!ctx.from || !ctx.from.id) return null

    const chatInfo = await ctx.telegram.getChat(ctx.from.id)
    return chatInfo.bio || null
  } catch (error) {
    console.error('[MODERATION] Error getting user bio:', error.message)
    return null
  }
}

/**
 * Check message content using OpenAI moderation API
 */
const checkOpenAIModeration = async (messageText, imageUrl = null, imageType = 'unknown') => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.log('[MODERATION] OpenAI API key not configured, skipping moderation check')
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
      console.log(`[MODERATION] Adding ${imageType} to moderation check`)
    }

    if (input.length === 0) {
      return null
    }

    const response = await openAI.moderations.create({
      model: 'omni-moderation-latest',
      input: input.length === 1 ? input[0].text : input
    })

    const result = response.results[0]

    if (result.flagged) {
      const flaggedCategories = Object.entries(result.categories)
        .filter(([_, flagged]) => flagged)
        .map(([category, _]) => category)

      const highestScore = Math.max(...Object.values(result.category_scores))

      console.log(`[MODERATION] Content flagged: ${flaggedCategories.join(', ')} (highest score: ${(highestScore * 100).toFixed(1)}%)`)

      return {
        flagged: true,
        categories: flaggedCategories,
        highestScore: highestScore * 100,
        reason: `Inappropriate content: ${flaggedCategories.join(', ')}`
      }
    }

    console.log('[MODERATION] Content passed moderation check')
    return { flagged: false }
  } catch (error) {
    console.error('[MODERATION] Error during moderation check:', error.message)
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
    const userAvatarUrl = await getUserProfilePhotoUrl(ctx)
    const userBio = await getUserBio(ctx)

    // Check text content first
    const textModerationResult = await checkOpenAIModeration(messageText, null, 'text')
    if (textModerationResult && textModerationResult.flagged) {
      console.log(`[SPAM CHECK] Text flagged by OpenAI moderation: ${textModerationResult.reason}`)
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
          console.log(`[SPAM CHECK] Message photo flagged by OpenAI moderation: ${photoModerationResult.reason}`)
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
        console.log(`[SPAM CHECK] User avatar flagged by OpenAI moderation: ${avatarModerationResult.reason}`)
        return {
          isSpam: true,
          confidence: Math.max(90, avatarModerationResult.highestScore),
          reason: avatarModerationResult.reason,
          source: 'openai_moderation_avatar',
          categories: avatarModerationResult.categories
        }
      }
    }

    // Create user context for analysis
    const userContext = {
      isNewAccount: isNewAccount(ctx),
      isPremium: (ctx.from && ctx.from.is_premium) || false,
      hasUsername: !!(ctx.from && ctx.from.username),
      hasProfile: hasUserProfile(ctx),
      messageCount: (ctx.session && ctx.session.userStats && ctx.session.userStats.messagesCount) || 0,
      previousWarnings: (ctx.session && ctx.session.userStats && ctx.session.userStats.warningsCount) || 0,
      accountAge: getAccountAge(ctx)
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
        console.log(`[SPAM CHECK] Qdrant match: ${localResult.classification} (${(localResult.confidence * 100).toFixed(1)}%)`)

        // If confidence is high enough, return local result
        const adaptiveThreshold = getAdaptiveThreshold(features)
        console.log(`[SPAM CHECK] Adaptive threshold: ${(adaptiveThreshold * 100).toFixed(1)}%`)

        if (localResult.confidence >= adaptiveThreshold) {
          console.log(`[SPAM CHECK] Using Qdrant result (confidence ${(localResult.confidence * 100).toFixed(1)}% >= threshold ${(adaptiveThreshold * 100).toFixed(1)}%)`)
          return {
            isSpam: localResult.classification === 'spam',
            confidence: localResult.confidence * 100,
            reason: `Vector match: ${localResult.classification}`,
            source: 'qdrant_db'
          }
        } else {
          console.log(`[SPAM CHECK] Qdrant confidence too low (${(localResult.confidence * 100).toFixed(1)}% < ${(adaptiveThreshold * 100).toFixed(1)}%), checking with LLM`)
        }
      }
    }

    // Calculate dynamic threshold for LLM check
    const dynamicThreshold = calculateDynamicThreshold(userContext, groupSettings)

    console.log(`[SPAM CHECK] Checking with OpenRouter LLM (threshold: ${dynamicThreshold}%)`)

    // Prepare context for LLM
    const contextInfo = []
    if (ctx.chat && ctx.chat.title) contextInfo.push(`Group: "${ctx.chat.title}"`)
    if (userContext.hasUsername) contextInfo.push(`Username: @${ctx.from.username}`)
    if (userContext.isPremium) contextInfo.push('Premium user: Yes')
    if (userContext.isNewAccount) contextInfo.push('New account: Yes')
    if (userContext.messageCount !== undefined) contextInfo.push(`Message count: ${userContext.messageCount}`)
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

    const systemPrompt = `You are an expert Telegram spam detection system. Your task is to classify messages as SPAM or CLEAN.

SPAM indicators:
• Crypto/trading schemes: "free crypto", "guaranteed profit", "trading signals"
• Adult content: dating sites, escort services, explicit material
• Scam schemes: fake giveaways, "click here to win", lottery winners
• Mass promotions: unsolicited advertising, group invitations
• Phishing: requests for personal data, suspicious links
• Suspicious user bio: crypto promotions, dating links, spam patterns
• Suspicious quoted text: spam content being referenced or promoted
• Suspicious reply patterns: inappropriate replies to legitimate messages
• External replies: replies to messages from suspicious channels or chats

CLEAN indicators:
• Normal conversation and questions
• Contextual replies to previous messages that make sense in context
• Legitimate discussions related to group topic
• Messages from premium users or established accounts
• Helpful responses to specific requests (e.g., providing asked-for links, answering questions)
• Replies that directly address the content of the original message

Classification guidelines:
• SPAM confidence 90-100%: Clear malicious intent, obvious patterns
• SPAM confidence 80-89%: Strong spam indicators but some uncertainty
• SPAM confidence 70-79%: Suspicious but borderline cases
• CLEAN confidence 85-100%: Clearly legitimate content
• Be conservative - when in doubt, classify as CLEAN to avoid false positives

Special attention to reply context:
• If message is a reply, analyze if the response makes sense given the original message
• Links/promotions may be legitimate if they were specifically requested
• Consider if the reply directly addresses questions or requests in the original message
• Unsolicited promotions in replies to unrelated messages are suspicious`

    const userPrompt = `Message to classify: "${messageText}"

User context:
${contextInfo.join('\n')}

Analyze and classify this message.`

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
      console.error('[SPAM CHECK] JSON parsing error:', parseError.message)
      console.error('[SPAM CHECK] Raw response content:', response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content)
      return null // Return null to indicate parsing failure
    }

    const isSpam = analysis.classification === 'SPAM'
    const confidence = parseInt(analysis.confidence) || 70

    console.log(`[SPAM CHECK] OpenRouter result: ${isSpam ? 'SPAM' : 'CLEAN'} (${confidence}%)`)

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
          console.log(`[SPAM CHECK] Saved vector to Qdrant (confidence: ${confidence}%)`)
        } catch (saveError) {
          console.error('[SPAM CHECK] Failed to save vector:', saveError.message)
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
    console.error('[SPAM CHECK] Error during spam check:', error)
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
