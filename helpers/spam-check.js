const { OpenAI } = require('openai')
const {
  extractFeatures,
  generateEmbedding,
  getAdaptiveThreshold
} = require('./message-embeddings')
const {
  saveSpamPattern,
  classifyBySimilarity,
  cleanupOldPatterns,
  mergeSimilarPatterns
} = require('./spam-patterns')
const {
  isNewAccount,
  getAccountAge
} = require('./account-age')

// Create OpenRouter client for LLM
const openRouter = new OpenAI({
  baseURL: process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY
})

// Schedule cleanup tasks on startup
let cleanupInitialized = false
const initializeCleanup = () => {
  if (!cleanupInitialized) {
    setInterval(async () => {
      try {
        const cleanedCount = await cleanupOldPatterns()
        const mergedCount = await mergeSimilarPatterns()
        if (cleanedCount > 0 || mergedCount > 0) {
          console.log(`[CLEANUP] Removed ${cleanedCount} old patterns, merged ${mergedCount} similar patterns`)
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
 * Analyze message frequency
 */
const analyzeMessageFrequency = (userStats) => {
  if (!userStats) return { isRapidFire: false, messagesPerMinute: 0 }
  return {
    isRapidFire: false,
    messagesPerMinute: 0,
    recentMessageCount: userStats.messagesCount || 0
  }
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
 * Main spam check function using hybrid approach
 */
const checkSpam = async (messageText, ctx, groupSettings) => {
  try {
    // Initialize cleanup on first run
    initializeCleanup()

    // Create user context for analysis
    const userContext = {
      isNewAccount: isNewAccount(ctx),
      isPremium: (ctx.from && ctx.from.is_premium) || false,
      hasUsername: !!(ctx.from && ctx.from.username),
      hasProfile: hasUserProfile(ctx),
      messageCount: (ctx.session && ctx.session.userStats && ctx.session.userStats.messagesCount) || 0,
      previousWarnings: (ctx.session && ctx.session.userStats && ctx.session.userStats.warningsCount) || 0,
      accountAge: getAccountAge(ctx),
      messageFrequency: analyzeMessageFrequency(ctx.session && ctx.session.userStats)
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
        console.log(`[SPAM CHECK] Local match: ${localResult.classification} (${(localResult.confidence * 100).toFixed(1)}%)`)

        // If confidence is high enough, return local result
        const adaptiveThreshold = getAdaptiveThreshold(features)
        console.log(`[SPAM CHECK] Adaptive threshold: ${(adaptiveThreshold * 100).toFixed(1)}%`)

        if (localResult.confidence >= adaptiveThreshold) {
          console.log(`[SPAM CHECK] Using local result (confidence ${(localResult.confidence * 100).toFixed(1)}% >= threshold ${(adaptiveThreshold * 100).toFixed(1)}%)`)
          return {
            isSpam: localResult.classification === 'spam',
            confidence: localResult.confidence * 100,
            reason: `Pattern match: ${localResult.classification}`,
            source: 'local_db'
          }
        } else {
          console.log(`[SPAM CHECK] Local confidence too low (${(localResult.confidence * 100).toFixed(1)}% < ${(adaptiveThreshold * 100).toFixed(1)}%), checking with LLM`)
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

    const systemPrompt = `You are a Telegram spam detection system. Analyze messages for common spam patterns.

Common spam patterns to detect:
- Cryptocurrency/trading schemes and pump-and-dump offers
- Dating/adult content solicitation and escort services
- Mass group invitations without context
- Fake giveaways and "free money" schemes
- Job scams and unrealistic work opportunities
- Phishing attempts and credential harvesting

Consider user context:
- Premium users are significantly less likely to be spammers
- New accounts (high user IDs) with first messages are more suspicious
- Users with established message history are more trustworthy
- Messages with context (replies) are often legitimate

Be conservative with borderline cases - false positives harm real users.

Respond with JSON: {"classification": "SPAM" or "CLEAN", "confidence": 0-100, "reasoning": "brief explanation"}`

    const userPrompt = `Message: "${messageText}"

Context:
${contextInfo.join('\n')}`

    // Use OpenRouter for LLM analysis
    const response = await openRouter.chat.completions.create({
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
      max_tokens: 200
    })

    const analysis = JSON.parse(response.choices[0].message.content)
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
          await saveSpamPattern({
            text: messageText,
            embedding,
            classification: isSpam ? 'spam' : 'clean',
            confidence: saveConfidence,
            features
          })
          console.log(`[SPAM CHECK] Saved pattern to knowledge base (confidence: ${confidence}%)`)
        } catch (saveError) {
          console.error('[SPAM CHECK] Failed to save pattern:', saveError.message)
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
  getSpamSettings
}
