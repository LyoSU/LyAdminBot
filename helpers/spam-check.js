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
  mergeSimilarPatterns,
  getKnowledgeStats
} = require('./spam-patterns')

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
 * Check if account is new
 */
const isNewAccount = (ctx) => {
  if (!ctx.from) return false
  const userId = ctx.from.id
  // IDs over 6 billion are newer accounts (2023+)
  return userId > 6000000000
}

/**
 * Get account age estimation
 */
const getAccountAge = (ctx) => {
  if (!ctx.from) return 'unknown'
  const userId = ctx.from.id
  if (userId > 7000000000) return 'very_new'
  if (userId > 6000000000) return 'new'
  if (userId > 5000000000) return 'recent'
  return 'established'
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
 * Calculate dynamic threshold for LLM
 */
const calculateDynamicThreshold = (context, groupSettings) => {
  let baseThreshold = (groupSettings && groupSettings.confidenceThreshold) || 70

  if (context.isNewAccount && context.messageCount <= 2) {
    baseThreshold -= 20
  }

  if (context.messageCount <= 1) {
    baseThreshold -= 15
  }

  if (context.isPremium) baseThreshold += 15
  if (context.hasProfile) baseThreshold += 10
  if (context.hasUsername) baseThreshold += 5
  if (context.messageCount > 10) baseThreshold += 10

  return Math.max(40, Math.min(95, baseThreshold))
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

    // Generate embedding for the message
    const embedding = await generateEmbedding(messageText)

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

    // Save to knowledge base if confidence is high enough
    if (embedding && confidence >= 80) {
      try {
        await saveSpamPattern({
          text: messageText,
          embedding,
          classification: isSpam ? 'spam' : 'clean',
          confidence: confidence / 100,
          features,
          source: 'llm_analysis'
        })
        console.log(`[SPAM CHECK] Saved pattern to knowledge base`)
      } catch (saveError) {
        console.error('[SPAM CHECK] Failed to save pattern:', saveError.message)
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

/**
 * Get spam knowledge statistics
 */
const getSpamStats = async () => {
  return getKnowledgeStats()
}

module.exports = {
  checkSpam,
  checkTrustedUser,
  getSpamSettings,
  getSpamStats
}
