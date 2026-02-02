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
  calculateVelocityScore,
  getForwardHash
} = require('./velocity')
const { checkSignatures, addSignature } = require('./spam-signatures')
const { spam: spamLog, moderation: modLog, cleanup: cleanupLog, qdrant: qdrantLog } = require('./logger')

// Create OpenRouter client for LLM
const openRouter = new OpenAI({
  baseURL: process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://LyAdminBot.t.me',
    'X-Title': 'LyAdminBot Spam Check Helper'
  }
})

// Create OpenAI client for moderation
const openAI = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

// Fallback models for retry logic
const FALLBACK_MODELS = [
  process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
  'google/gemini-3-flash-preview'
]

/**
 * Sleep helper for exponential backoff
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Convert technical spam reasons to user-friendly messages via i18n
 * Technical reasons are useful for logs but confusing for users
 *
 * @param {string} reason - Technical reason string
 * @param {Object} i18n - i18n context with t() method
 * @returns {string} - User-friendly reason
 */
const humanizeReason = (reason, i18n) => {
  if (!reason) {
    return i18n ? i18n.t('spam_vote.reasons.default') : 'Spam detected'
  }

  // Mapping of technical patterns to i18n keys
  const patternToKey = {
    'Vector match: spam': 'spam_vote.reasons.vector_spam',
    'Vector match: clean': 'spam_vote.reasons.vector_clean',
    'Exact hash match': 'spam_vote.reasons.exact_hash',
    'Normalized hash match': 'spam_vote.reasons.normalized_hash',
    'Fuzzy match': 'spam_vote.reasons.fuzzy_match',
    'Inappropriate content': 'spam_vote.reasons.inappropriate',
    'Cross-group spam': 'spam_vote.reasons.cross_group',
    'High velocity': 'spam_vote.reasons.high_velocity',
    'Error during analysis': 'spam_vote.reasons.error'
  }

  // Check exact matches first
  if (patternToKey[reason] && i18n) {
    return i18n.t(patternToKey[reason])
  }

  // Check partial matches for dynamic reasons
  for (const [pattern, key] of Object.entries(patternToKey)) {
    if (reason.includes(pattern.split(':')[0]) && i18n) {
      return i18n.t(key)
    }
  }

  // Custom rule matches - extract the rule and show user-friendly
  if (reason.startsWith('Blocked by custom rule:') && i18n) {
    const rule = reason.replace('Blocked by custom rule:', '').trim().replace(/"/g, '')
    return `${i18n.t('spam_vote.reasons.custom_blocked')}: ${rule}`
  }
  if (reason.startsWith('Allowed by custom rule:') && i18n) {
    const rule = reason.replace('Allowed by custom rule:', '').trim().replace(/"/g, '')
    return `${i18n.t('spam_vote.reasons.custom_allowed')}: ${rule}`
  }

  // If it's already a human-readable LLM reason (longer text), keep it
  if (reason.length > 50) {
    return reason
  }

  // Fallback - return original if not in mapping
  return reason
}

/**
 * Call LLM with retry and fallback logic
 * @param {string} systemPrompt - System prompt
 * @param {string} userPrompt - User prompt
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Object|null} - { analysis, model } or null on failure
 */
const callLLMWithRetry = async (systemPrompt, userPrompt, maxRetries = 3) => {
  let lastError = null
  let modelIndex = 0

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const model = FALLBACK_MODELS[Math.min(modelIndex, FALLBACK_MODELS.length - 1)]

    try {
      const response = await openRouter.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 1.0,
        reasoning_effort: 'low',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'spam_analysis',
            schema: {
              type: 'object',
              properties: {
                reason: {
                  type: 'string',
                  description: 'Short explanation for admins (1-2 sentences)'
                },
                spamScore: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Probability this is spam (0.0=clean, 1.0=definitely spam)'
                }
              },
              required: ['reason', 'spamScore'],
              additionalProperties: false
            }
          }
        },
        max_tokens: 1024
      })

      const content = response.choices[0].message.content
      const trimmedContent = content && content.trim()

      if (!trimmedContent) {
        const finishReason = response.choices[0].finish_reason
        spamLog.warn({
          attempt: attempt + 1,
          model,
          finishReason
        }, 'Empty LLM response, retrying')

        // Switch to fallback model on empty response
        modelIndex++
        lastError = new Error(`Empty response (finish_reason: ${finishReason})`)

        // Exponential backoff: 100ms, 200ms, 400ms
        await sleep(100 * Math.pow(2, attempt))
        continue
      }

      const analysis = JSON.parse(trimmedContent)

      // Log if we used a fallback model
      if (attempt > 0) {
        spamLog.info({ model, attempt: attempt + 1 }, 'LLM succeeded after retry')
      }

      return { analysis, model }
    } catch (err) {
      lastError = err
      spamLog.warn({
        attempt: attempt + 1,
        model,
        err: err.message
      }, 'LLM call failed, retrying')

      // Switch to fallback model on error
      modelIndex++

      // Exponential backoff
      await sleep(100 * Math.pow(2, attempt))
    }
  }

  spamLog.error({ err: lastError && lastError.message, attempts: maxRetries }, 'All LLM retry attempts failed')
  return null
}

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
 * Quick risk assessment based on Telegram-specific signals
 * Returns risk level: 'skip' | 'low' | 'medium' | 'high'
 *
 * This function analyzes metadata BEFORE expensive API calls to:
 * 1. Skip checks entirely for obviously clean messages
 * 2. Skip OpenAI moderation for low-risk messages
 * 3. Flag high-risk signals for closer inspection
 *
 * @param {Object} ctx - Telegram context
 * @returns {Object} { risk: string, signals: string[], trustSignals: string[] }
 */
const quickRiskAssessment = (ctx) => {
  const message = ctx.message
  if (!message) return { risk: 'medium', signals: [], trustSignals: [] }

  const signals = [] // Suspicious signals
  const trustSignals = [] // Trust signals

  // ===== HIGH RISK SIGNALS =====

  // 1. Forward from hidden user (common spam pattern)
  if (message.forward_origin) {
    if (message.forward_origin.type === 'hidden_user') {
      signals.push('forward_hidden_user')
    } else if (message.forward_origin.type === 'channel') {
      // Forward from channel - moderate risk
      signals.push('forward_channel')
    }
  }

  // 2. Inline keyboard with URLs (promo buttons)
  if (message.reply_markup && message.reply_markup.inline_keyboard) {
    const buttons = message.reply_markup.inline_keyboard.flat()
    const urlButtons = buttons.filter(btn => btn.url)
    if (urlButtons.length > 0) {
      signals.push('inline_url_buttons')
      // Multiple URL buttons = higher risk
      if (urlButtons.length >= 3) {
        signals.push('many_url_buttons')
      }
    }
  }

  // 3. Suspicious entities in text
  const entities = message.entities || message.caption_entities || []
  const text = message.text || message.caption || ''

  for (const entity of entities) {
    // Cashtags ($BTC, $ETH) - crypto spam
    if (entity.type === 'cashtag') {
      signals.push('cashtag')
    }
    // Hidden text links (text says one thing, links to another)
    if (entity.type === 'text_link') {
      const linkText = text.substring(entity.offset, entity.offset + entity.length)
      // Check if link text looks like a different URL
      if (/^(https?:\/\/|www\.|t\.me)/i.test(linkText) && linkText !== entity.url) {
        signals.push('hidden_url')
      }
    }
    // Phone numbers in first message - often spam
    if (entity.type === 'phone_number') {
      signals.push('phone_number')
    }
  }

  // 3.5. Plain text URLs (t.me links, other external links)
  // Spammers often use plain text URLs that don't create entities
  const urlRegex = /(?:https?:\/\/|t\.me\/|bit\.ly\/|goo\.gl\/|tinyurl\.com\/|choko\.link\/|wa\.me\/|telegram\.me\/)/i
  if (urlRegex.test(text)) {
    signals.push('text_url')
  }

  // 3.6. Long promotional text (> 200 chars) - unlikely to be casual conversation
  if (text.length > 200) {
    signals.push('long_text')
  }

  // 4. Via bot (might be automated)
  if (message.via_bot) {
    signals.push('via_bot')
  }

  // 5. Web preview without link in text (bot-added preview)
  // Bots can add link_preview_options with URL not present in message text
  if (message.link_preview_options && message.link_preview_options.url) {
    const previewUrl = message.link_preview_options.url.toLowerCase()
    const textLower = text.toLowerCase()
    // Check if preview URL is NOT in the message text
    if (!textLower.includes(previewUrl.replace(/^https?:\/\//, '').split('/')[0])) {
      signals.push('hidden_preview')
    }
  }

  // 6. Contact sharing (phone number as contact, not text)
  if (message.contact) {
    signals.push('shared_contact')
    // Contact with different user_id than sender = suspicious
    if (message.contact.user_id && ctx.from && message.contact.user_id !== ctx.from.id) {
      signals.push('foreign_contact')
    }
  }

  // 7. Location sharing (often used in scams)
  if (message.location && !message.venue) {
    // Raw location without venue context
    signals.push('raw_location')
  }

  // 8. Dice/Game messages - suspicious only if NOT a reply
  // Dice as reply to conversation = having fun, not spam
  if ((message.dice || message.game) && !message.reply_to_message) {
    signals.push('game_message')
  }

  // 9. Voice/Video message - suspicious only if NOT a reply
  // Voice reply = real conversation
  if ((message.voice || message.video_note) && !message.reply_to_message) {
    signals.push('voice_video_note')
  }

  // 10. Poll/Quiz (can be used for engagement farming)
  if (message.poll) {
    signals.push('poll_message')
  }

  // 11. Premium emoji in name (common spam pattern)
  const user = ctx.from
  if (user) {
    const name = `${user.first_name || ''} ${user.last_name || ''}`
    // Check for excessive emojis in name (more than 2)
    // Extended emoji ranges
    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu
    const emojiCount = (name.match(emojiRegex) || []).length
    if (emojiCount > 2) {
      signals.push('emoji_name')
    }
  }

  // 12. Story mention/forward (new TG feature, can be abused)
  if (message.story) {
    signals.push('story_forward')
  }

  // 13. Paid media (premium content promotion)
  if (message.paid_media) {
    signals.push('paid_media')
  }

  // 14. Effect ID (message effects - sometimes used to grab attention)
  if (message.effect_id) {
    signals.push('message_effect')
  }

  // 15. Business connection (business account messages)
  if (message.business_connection_id) {
    signals.push('business_message')
  }

  // 16. Giveaway messages (can be fake/scam giveaways in groups/channels)
  if (message.giveaway || message.giveaway_winners || message.giveaway_created || message.giveaway_completed) {
    signals.push('giveaway_message')
  }

  // Note: invoice, web_app_data, users_shared, chat_shared are NOT relevant
  // for supergroups - they only occur in private chats with bots

  // ===== TRUST SIGNALS =====

  // 1. Reply to another message (engagement = conversation)
  // But NOT if replying to own message (spammers reply to themselves)
  if (message.reply_to_message) {
    const replyToFrom = message.reply_to_message.from
    const isReplyToSelf = user && replyToFrom && replyToFrom.id === user.id
    
    if (!isReplyToSelf) {
      trustSignals.push('is_reply')
      // Reply to recent message (within 1 hour) = even more trust
      // Safety: check both dates exist before calculating
      if (message.date && message.reply_to_message.date) {
        const replyAge = message.date - message.reply_to_message.date
        if (replyAge >= 0 && replyAge < 3600) { // 1 hour, and positive (not future)
          trustSignals.push('recent_reply')
        }
      }
    }
  }

  // 2. Quote (user is referencing specific text)
  if (message.quote) {
    trustSignals.push('has_quote')
  }

  // 3. Sticker/GIF only (rarely spam)
  if ((message.sticker || message.animation) && !text) {
    trustSignals.push('media_only')
  }

  // 4. Short text replies (conversational)
  if (text.length < 50 && !signals.length) {
    trustSignals.push('short_message')
  }

  // ===== RISK CALCULATION =====

  // Critical signals = instant high risk
  const criticalSignals = [
    'forward_hidden_user', // Hidden forward source
    'hidden_url', // Deceptive text links
    'hidden_preview', // Bot-added link preview
    'many_url_buttons', // 3+ URL buttons
    'foreign_contact' // Sharing someone else's contact
  ]
  const hasCritical = signals.some(s => criticalSignals.includes(s))

  // Medium-weight signals (suspicious but not critical alone)
  const mediumSignals = [
    'cashtag', // Crypto mentions
    'inline_url_buttons', // Any URL buttons
    'phone_number', // Phone in text
    'shared_contact', // Contact card
    'paid_media', // Premium content promo
    'giveaway_message' // Fake/scam giveaways
  ]
  const mediumCount = signals.filter(s => mediumSignals.includes(s)).length

  if (hasCritical || signals.length >= 3 || mediumCount >= 2) {
    return { risk: 'high', signals, trustSignals }
  }

  // Skip: strong trust signals with no suspicious signals
  if (signals.length === 0 && trustSignals.length >= 2) {
    return { risk: 'skip', signals, trustSignals }
  }

  // Low: trust signals outweigh risk, or just media
  if (trustSignals.length > signals.length || trustSignals.includes('media_only')) {
    return { risk: 'low', signals, trustSignals }
  }

  // Medium: some signals but not critical
  if (signals.length > 0) {
    return { risk: 'medium', signals, trustSignals }
  }

  // Default: low risk for clean messages
  return { risk: 'low', signals, trustSignals }
}

/**
 * Apply custom rules to message text
 * Rules format: "ALLOW: pattern" or "DENY: pattern"
 * DENY rules have priority over ALLOW rules
 *
 * @param {string} messageText - The message text to check
 * @param {string[]} customRules - Array of custom rules
 * @returns {Object|null} - { action: 'allow'|'deny', rule: string } or null if no match
 */
const applyCustomRules = (messageText, customRules) => {
  if (!customRules || customRules.length === 0 || !messageText) {
    return null
  }

  const textLower = messageText.toLowerCase()
  let allowMatch = null

  for (const rule of customRules) {
    const isDeny = rule.startsWith('DENY:')
    const isAllow = rule.startsWith('ALLOW:')

    if (!isDeny && !isAllow) continue

    // Extract pattern after "ALLOW: " or "DENY: "
    const pattern = rule.substring(rule.indexOf(':') + 1).trim().toLowerCase()
    if (!pattern) continue

    // Check if pattern matches (simple substring match, case-insensitive)
    // For more advanced matching, could use regex but that requires careful escaping
    const patternMatches = textLower.includes(pattern)

    if (patternMatches) {
      if (isDeny) {
        // DENY has priority - return immediately
        return { action: 'deny', rule: pattern, type: 'DENY' }
      } else if (isAllow && !allowMatch) {
        // Store first ALLOW match, but continue checking for DENY
        allowMatch = { action: 'allow', rule: pattern, type: 'ALLOW' }
      }
    }
  }

  return allowMatch
}

/**
 * Check if user has user profile (bio, photo, etc)
 */
const hasUserProfile = (ctx) => {
  const user = ctx.from
  return !!(user && (user.username || user.is_premium))
}

/**
 * Calculate dynamic threshold for LLM - Balanced approach to minimize false positives
 *
 * Philosophy: Don't penalize "newness" alone. Only adjust threshold based on:
 * 1. POSITIVE signals (trust indicators)
 * 2. SUSPICIOUS signals from quick assessment
 * 3. Historical reputation data
 *
 * Higher threshold = harder to trigger spam action = more lenient
 */
const calculateDynamicThreshold = (context, groupSettings) => {
  let baseThreshold = (groupSettings && groupSettings.confidenceThreshold) || 75

  // ===== TRUST INDICATORS (raise threshold = more lenient) =====

  // Premium users are unlikely to be spammers
  if (context.isPremium) baseThreshold += 20

  // Profile indicators
  if (context.hasProfile) baseThreshold += 10
  if (context.hasUsername) baseThreshold += 8

  // Message history in this group
  if (context.messageCount > 10) baseThreshold += 15
  else if (context.messageCount > 5) baseThreshold += 10
  else if (context.messageCount > 2) baseThreshold += 5

  // Account age (only BOOST for established, don't penalize new)
  if (context.accountAge === 'established') baseThreshold += 10

  // Reply context - trust signal for established users only
  // New users (0-1 messages) don't get reply bonus - spam bots abuse this
  if (context.isReply && context.messageCount > 1) {
    baseThreshold += 12 // Significant boost for replies
    // Recent replies (within 1 hour) get extra trust
    if (context.replyAge && context.replyAge < 3600) {
      baseThreshold += 5
    }
  }

  // Global reputation (from cross-group tracking)
  if (context.globalReputation) {
    const rep = context.globalReputation
    if (rep.status === 'trusted') {
      baseThreshold += 25 // Should be skipped earlier, but safety net
    } else if (rep.status === 'neutral' && rep.score > 60) {
      baseThreshold += Math.floor((rep.score - 50) / 5) * 2 // +2 to +10
    }
  }

  // Telegram Stars rating (paid = trusted)
  if (context.telegramRating) {
    const level = context.telegramRating.level || 0
    if (level > 0) {
      baseThreshold += Math.min(15, level * 5) // +5 to +15
    }
  }

  // ===== SUSPICIOUS SIGNALS (lower threshold = stricter) =====

  // Only penalize based on ACTUAL suspicious signals, not "newness"
  if (context.quickAssessment) {
    const qa = context.quickAssessment
    if (qa.risk === 'high') {
      // High risk from quick assessment - be stricter
      baseThreshold -= 10
    } else if (qa.risk === 'medium' && qa.signals && qa.signals.length >= 2) {
      // Multiple medium-risk signals
      baseThreshold -= 5
    }
  }

  // Reputation-based penalties (historical bad behavior)
  if (context.globalReputation) {
    const rep = context.globalReputation
    if (rep.status === 'suspicious') {
      baseThreshold -= 10
    } else if (rep.status === 'restricted') {
      baseThreshold -= 20
    }
  }

  // Telegram Stars negative rating
  if (context.telegramRating && context.telegramRating.level < 0) {
    baseThreshold -= 10
  }

  // Edited messages - could be spam added after passing initial check
  // Be more suspicious of edits from users with few messages
  if (context.isEditedMessage && context.messageCount <= 5) {
    baseThreshold -= 8
  }

  // ===== BOUNDS =====
  // Min 60 (was 50) - avoid over-aggressive blocking
  // Max 95 - always allow some spam detection
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

    // For single text input, send as string; for images or multiple inputs, send as array
    const apiInput = (input.length === 1 && input[0].type === 'text')
      ? input[0].text
      : input

    const response = await openAI.moderations.create({
      model: 'omni-moderation-latest',
      input: apiInput
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

// ========== PHASE FUNCTIONS ==========

/**
 * PHASE 0: Check custom rules (fastest check)
 * @returns {Object|null} Result if rule matched, null to continue
 */
const checkCustomRulesPhase = (messageText, groupSettings) => {
  if (!groupSettings || !groupSettings.customRules) return null

  const ruleResult = applyCustomRules(messageText, groupSettings.customRules)
  if (!ruleResult) return null

  if (ruleResult.action === 'deny') {
    spamLog.info({ rule: ruleResult.rule }, 'Message blocked by DENY rule')
    return {
      isSpam: true,
      confidence: 95,
      reason: `Blocked by custom rule: "${ruleResult.rule}"`,
      source: 'custom_rule_deny'
    }
  }

  if (ruleResult.action === 'allow') {
    spamLog.debug({ rule: ruleResult.rule }, 'Message allowed by ALLOW rule')
    return {
      isSpam: false,
      confidence: 95,
      reason: `Allowed by custom rule: "${ruleResult.rule}"`,
      source: 'custom_rule_allow'
    }
  }

  return null
}

/**
 * PHASE 0.5: Check SpamSignature (community-confirmed patterns)
 * @returns {Object} { result: Object|null, candidateBoost: number }
 */
const checkSpamSignaturesPhase = async (messageText, ctx) => {
  if (!ctx.db || !ctx.db.SpamSignature) {
    return { result: null, candidateBoost: 0 }
  }

  // Check confirmed signatures first
  try {
    const signatureMatch = await checkSignatures(messageText, ctx.db)
    if (signatureMatch) {
      spamLog.info({
        matchType: signatureMatch.match,
        confidence: signatureMatch.confidence,
        distance: signatureMatch.distance
      }, 'Matched spam signature')

      return {
        result: {
          isSpam: true,
          confidence: signatureMatch.confidence,
          reason: signatureMatch.reason,
          source: `spam_signature_${signatureMatch.match}`
        },
        candidateBoost: 0
      }
    }
  } catch (sigErr) {
    spamLog.warn({ err: sigErr.message }, 'SpamSignature check failed, continuing')
  }

  // Check candidate signatures for confidence boosting
  let candidateBoost = 0
  try {
    const candidateMatch = await checkSignatures(messageText, ctx.db, { requireConfirmed: false })
    if (candidateMatch && candidateMatch.signature && candidateMatch.signature.status === 'candidate') {
      const hasEnoughConfirmations = candidateMatch.signature.confirmations >= 2 ||
        candidateMatch.signature.uniqueGroups.length >= 2

      if ((candidateMatch.match === 'fuzzy' || candidateMatch.match === 'structure') && hasEnoughConfirmations) {
        candidateBoost = 8
        spamLog.debug({
          matchType: candidateMatch.match,
          confirmations: candidateMatch.signature.confirmations,
          uniqueGroups: candidateMatch.signature.uniqueGroups.length,
          boost: candidateBoost
        }, 'Candidate signature match - will boost confidence')
      }
    }
  } catch (sigErr) {
    // Silent fail for candidate check
  }

  return { result: null, candidateBoost }
}

/**
 * PHASE 0.6: Check ForwardBlacklist (for forwarded messages)
 * @returns {Object} { result: Object|null, suspiciousBoost: number }
 */
const checkForwardBlacklistPhase = async (ctx) => {
  const forwardOrigin = ctx.message && ctx.message.forward_origin
  if (!forwardOrigin || !ctx.db || !ctx.db.ForwardBlacklist) {
    return { result: null, suspiciousBoost: 0 }
  }

  try {
    const forwardInfo = getForwardHash(forwardOrigin)
    if (!forwardInfo) return { result: null, suspiciousBoost: 0 }

    const blacklistEntry = await ctx.db.ForwardBlacklist.checkSource(forwardInfo.hash)
    if (!blacklistEntry) return { result: null, suspiciousBoost: 0 }

    if (blacklistEntry.status === 'blacklisted') {
      spamLog.info({
        forwardType: blacklistEntry.forwardType,
        spamReports: blacklistEntry.spamReports,
        uniqueGroups: blacklistEntry.uniqueGroups.length
      }, 'Matched blacklisted forward source')

      return {
        result: {
          isSpam: true,
          confidence: 95,
          reason: `Blacklisted forward source (${blacklistEntry.forwardType}, ${blacklistEntry.spamReports} reports)`,
          source: 'forward_blacklist',
          forwardInfo: {
            type: blacklistEntry.forwardType,
            hash: forwardInfo.hash,
            status: blacklistEntry.status
          }
        },
        suspiciousBoost: 0
      }
    }

    if (blacklistEntry.status === 'suspicious') {
      const boost = Math.min(15, 5 + blacklistEntry.spamReports * 2)
      spamLog.debug({
        forwardType: blacklistEntry.forwardType,
        spamReports: blacklistEntry.spamReports,
        boost
      }, 'Forward from suspicious source - will boost confidence')
      return { result: null, suspiciousBoost: boost }
    }
  } catch (fwdErr) {
    spamLog.warn({ err: fwdErr.message }, 'ForwardBlacklist check failed, continuing')
  }

  return { result: null, suspiciousBoost: 0 }
}

/**
 * PHASE 1: Quick Risk Assessment
 * @returns {Object} { result: Object|null, quickAssessment: Object }
 */
const runQuickAssessmentPhase = (ctx) => {
  let quickAssessment = { risk: 'medium', signals: [], trustSignals: [] }

  try {
    quickAssessment = quickRiskAssessment(ctx)

    if (quickAssessment.signals.length > 0 || quickAssessment.trustSignals.length > 0) {
      spamLog.debug({
        risk: quickAssessment.risk,
        signals: quickAssessment.signals,
        trustSignals: quickAssessment.trustSignals
      }, 'Quick assessment')
    }

    // Quick assessment is now only used for signal collection, not for skipping
    // All messages go through Qdrant check (it's fast) to catch known spam patterns
  } catch (quickAssessErr) {
    spamLog.warn({ err: quickAssessErr.message }, 'Quick assessment error, continuing with standard flow')
  }

  return { result: null, quickAssessment }
}

/**
 * PHASE 2: OpenAI Moderation Check
 * @returns {Object|null} Result if content flagged, null to continue
 */
const runModerationPhase = async (ctx, messageText, quickAssessment, userBio, userAvatarUrl) => {
  if (quickAssessment.risk === 'low') {
    spamLog.debug('Skipping OpenAI moderation for low-risk message')
    return null
  }

  const messagePhoto = ctx.message && ctx.message.photo && ctx.message.photo[0]
  const messagePhotoUrl = messagePhoto && messagePhoto.file_id
    ? await getMessagePhotoUrl(ctx, messagePhoto)
    : null

  const textToModerate = [messageText, userBio].filter(Boolean).join('\n\n')
  const moderationPromises = []
  const moderationSources = []

  moderationPromises.push(checkOpenAIModeration(textToModerate, null, 'text+bio'))
  moderationSources.push('openai_moderation_text')

  if (messagePhotoUrl) {
    moderationPromises.push(checkOpenAIModeration(messageText, messagePhotoUrl, 'message photo'))
    moderationSources.push('openai_moderation_photo')
  }

  if (userAvatarUrl) {
    moderationPromises.push(checkOpenAIModeration(null, userAvatarUrl, 'user avatar'))
    moderationSources.push('openai_moderation_avatar')
  }

  const moderationResults = await Promise.all(moderationPromises)

  for (let i = 0; i < moderationResults.length; i++) {
    const result = moderationResults[i]
    if (result && result.flagged) {
      const source = moderationSources[i] || 'openai_moderation'
      spamLog.warn({ reason: result.reason, source }, 'Content flagged by OpenAI moderation')
      return {
        isSpam: true,
        confidence: Math.max(90, result.highestScore),
        reason: result.reason,
        source,
        categories: result.categories,
        quickAssessment
      }
    }
  }

  return null
}

/**
 * Build user context object for analysis
 */
const buildUserContext = (ctx, userRating, quickAssessment) => {
  const senderChat = ctx.message && ctx.message.sender_chat
  const isChannelPost = senderChat && senderChat.type === 'channel'
  const senderId = isChannelPost ? senderChat.id : (ctx.from && ctx.from.id)

  const perGroupMessageCount = ctx.group && ctx.group.members && senderId &&
    ctx.group.members[senderId] && ctx.group.members[senderId].stats &&
    ctx.group.members[senderId].stats.messagesCount
  const globalMessageCount = ctx.session && ctx.session.userInfo &&
    ctx.session.userInfo.globalStats && ctx.session.userInfo.globalStats.totalMessages
  const globalStats = (ctx.session && ctx.session.userInfo && ctx.session.userInfo.globalStats) || {}

  const replyToMessage = ctx.message && ctx.message.reply_to_message
  const isReply = !!replyToMessage
  const replyAge = replyToMessage ? (ctx.message.date - replyToMessage.date) : null

  return {
    isNewAccount: isChannelPost ? true : isNewAccount(ctx),
    isPremium: isChannelPost ? false : ((ctx.from && ctx.from.is_premium) || false),
    hasUsername: isChannelPost ? !!(senderChat.username) : !!(ctx.from && ctx.from.username),
    hasProfile: isChannelPost ? false : hasUserProfile(ctx),
    messageCount: perGroupMessageCount || 0,
    globalMessageCount: isChannelPost ? 0 : (globalMessageCount || 0),
    groupsActive: isChannelPost ? 0 : (globalStats.groupsActive || 0),
    previousWarnings: globalStats.spamDetections || 0,
    accountAge: isChannelPost ? 'unknown' : getAccountAge(ctx),
    globalReputation: isChannelPost
      ? { score: 30, status: 'suspicious' }
      : (ctx.session && ctx.session.userInfo && ctx.session.userInfo.reputation) || { score: 50, status: 'neutral' },
    telegramRating: userRating,
    isChannelPost,
    channelTitle: isChannelPost ? senderChat.title : null,
    channelUsername: isChannelPost ? senderChat.username : null,
    isReply,
    replyAge,
    quickAssessment,
    // Will be set by velocity check
    velocityBoost: 0,
    velocityReason: null
  }
}

/**
 * PHASE 3: Velocity Check
 * @returns {Object|null} Result if high velocity spam, null to continue
 */
const runVelocityPhase = async (messageText, ctx, userContext) => {
  const senderChat = ctx.message && ctx.message.sender_chat
  const isChannelPost = senderChat && senderChat.type === 'channel'
  const senderId = isChannelPost ? senderChat.id : (ctx.from && ctx.from.id)

  try {
    if (!senderId || !ctx.chat || !ctx.chat.id || !ctx.message) {
      throw new Error('Missing context for velocity check')
    }

    const forwardOrigin = ctx.message.forward_origin || null
    const velocityResult = await calculateVelocityScore(
      messageText,
      senderId,
      ctx.chat.id,
      ctx.message.message_id,
      forwardOrigin
    )

    if (velocityResult.score > 0) {
      spamLog.debug({ velocityScore: (velocityResult.score * 100).toFixed(1), dominant: velocityResult.dominant }, 'Velocity score')
    }

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

    if (velocityResult.score >= 0.4) {
      userContext.velocityBoost = velocityResult.score * 20
      userContext.velocityReason = velocityResult.dominant
    }
  } catch (velocityError) {
    spamLog.error({ err: velocityError.message }, 'Velocity check error')
  }

  return null
}

/**
 * PHASE 4: Qdrant Vector Check
 * @returns {Object|null} Result if confident match, null to continue
 */
const runQdrantPhase = async (messageText, ctx, userContext) => {
  const hasCaption = messageText !== ctx.message.text && !!ctx.message.caption
  const embedding = await generateEmbedding(messageText, {
    isNewAccount: userContext.isNewAccount,
    messageCount: userContext.messageCount,
    hasCaption
  })

  if (!embedding) return { result: null, embedding: null, features: null }

  const features = extractFeatures(messageText, userContext)
  const localResult = await classifyBySimilarity(embedding)

  if (!localResult) return { result: null, embedding, features }

  qdrantLog.debug({ classification: localResult.classification, confidence: (localResult.confidence * 100).toFixed(1) }, 'Qdrant match found')

  const adaptiveThreshold = getAdaptiveThreshold(features)
  qdrantLog.debug({ threshold: (adaptiveThreshold * 100).toFixed(1) }, 'Adaptive threshold')

  if (localResult.confidence < adaptiveThreshold) {
    qdrantLog.debug({ confidence: (localResult.confidence * 100).toFixed(1), threshold: (adaptiveThreshold * 100).toFixed(1) }, 'Qdrant confidence too low, checking with LLM')
    return { result: null, embedding, features }
  }

  // Check if new user with clean result - don't trust, need LLM for bio context
  const senderChat = ctx.message && ctx.message.sender_chat
  const isChannelPost = senderChat && senderChat.type === 'channel'
  const senderId = isChannelPost ? senderChat.id : (ctx.from && ctx.from.id)
  const perGroupMsgCount = ctx.group && ctx.group.members && senderId &&
    ctx.group.members[senderId] && ctx.group.members[senderId].stats &&
    ctx.group.members[senderId].stats.messagesCount
  const isFirstMessage = (perGroupMsgCount || 0) <= 1

  if (isFirstMessage && localResult.classification === 'clean') {
    qdrantLog.debug({ confidence: (localResult.confidence * 100).toFixed(1) }, 'New user - not trusting Qdrant clean result, checking with LLM for bio context')
    return { result: null, embedding, features }
  }

  qdrantLog.info({ confidence: (localResult.confidence * 100).toFixed(1), threshold: (adaptiveThreshold * 100).toFixed(1) }, 'Using Qdrant result')

  // Promote high-hit spam vectors to SpamSignature
  if (
    localResult.classification === 'spam' &&
    localResult.hitCount >= 5 &&
    localResult.confidence >= 0.9 &&
    ctx.db && ctx.db.SpamSignature &&
    ctx.chat && ctx.chat.id
  ) {
    setImmediate(async () => {
      try {
        const signature = await addSignature(messageText, ctx.db, ctx.chat.id, { source: 'vector_promotion' })
        if (signature) {
          qdrantLog.info({
            hitCount: localResult.hitCount,
            status: signature.status,
            uniqueGroups: signature.uniqueGroups.length
          }, 'Promoted vector to SpamSignature')
        }
      } catch (err) {
        qdrantLog.warn({ err: err.message }, 'Vector promotion failed')
      }
    })
  }

  return {
    result: {
      isSpam: localResult.classification === 'spam',
      confidence: localResult.confidence * 100,
      reason: `Vector match: ${localResult.classification}`,
      source: 'qdrant_db'
    },
    embedding,
    features
  }
}

/**
 * Build LLM context info array
 */
const buildLLMContext = (ctx, userContext, groupDescription, userBio) => {
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
    if (level > 0) contextInfo.push(`Telegram Stars buyer (level ${level}) - trusted`)
    else if (level < 0) contextInfo.push(`Telegram rating: negative (level ${level})`)
  }

  if (userBio && userBio.trim()) contextInfo.push(`User bio: "${userBio.trim()}"`)
  if (ctx.message && ctx.message.quote && ctx.message.quote.text) {
    contextInfo.push(`Quoted text: "${ctx.message.quote.text.trim()}"`)
  }

  // Regular reply context
  if (ctx.message && ctx.message.reply_to_message) {
    const replyTo = ctx.message.reply_to_message
    const replyInfo = []

    if (replyTo.from) {
      const replyToUser = replyTo.from.username ? `@${replyTo.from.username}` : replyTo.from.first_name
      replyInfo.push(`Reply to: ${replyToUser}`)
    }

    if (replyTo.text && replyTo.text.trim()) {
      const snippet = replyTo.text.trim().substring(0, 200)
      replyInfo.push(`Original message: "${snippet}${replyTo.text.length > 200 ? '...' : ''}"`)
    } else if (replyTo.caption && replyTo.caption.trim()) {
      const snippet = replyTo.caption.trim().substring(0, 200)
      replyInfo.push(`Original caption: "${snippet}${replyTo.caption.length > 200 ? '...' : ''}"`)
    }

    if (replyInfo.length > 0) contextInfo.push(`Reply context: ${replyInfo.join(', ')}`)
  }

  // External reply context
  if (ctx.message && ctx.message.external_reply) {
    const externalReply = ctx.message.external_reply
    const replyInfo = []

    if (externalReply.origin) {
      if (externalReply.origin.type === 'user' && externalReply.origin.sender_user) {
        replyInfo.push(`Reply to user: @${externalReply.origin.sender_user.username || externalReply.origin.sender_user.first_name}`)
      } else if (externalReply.origin.type === 'channel' && externalReply.origin.chat) {
        replyInfo.push(`Reply to channel: ${externalReply.origin.chat.title || externalReply.origin.chat.username}`)
      } else if (externalReply.origin.type === 'chat' && externalReply.origin.sender_chat) {
        replyInfo.push(`Reply to chat: ${externalReply.origin.sender_chat.title}`)
      }
    }

    if (externalReply.chat && externalReply.chat.title) {
      replyInfo.push(`Original chat: "${externalReply.chat.title}"`)
    }

    if (replyInfo.length > 0) contextInfo.push(`External reply: ${replyInfo.join(', ')}`)
  }

  return contextInfo
}

/**
 * PHASE 5: LLM Analysis
 */
const runLLMPhase = async (messageText, ctx, userContext, groupSettings, groupDescription, userBio, boosts, embedding, features) => {
  const { candidateBoost, suspiciousForwardBoost } = boosts

  const dynamicThreshold = calculateDynamicThreshold(userContext, groupSettings)
  spamLog.debug({ threshold: dynamicThreshold, msgLength: messageText.length }, 'Fallback to OpenRouter LLM')

  const contextInfo = buildLLMContext(ctx, userContext, groupDescription, userBio)

  const systemPrompt = `Telegram spam classifier. Output JSON: reason, spamScore.

SPAM = ads, scams, phishing, crypto schemes, service promotion, mass messaging, romantic/dating bots (suggestive phrases to lure into private chat).
NOT SPAM = genuine chatting, questions, jokes, trolling, rudeness, arguments.

spamScore (0.0-1.0) = probability this is spam:
  0.0-0.3: definitely not spam (normal chat, questions, even rude)
  0.3-0.5: unlikely spam (suspicious but probably ok)
  0.5-0.7: uncertain (could go either way)
  0.7-0.85: likely spam (promotional, sketchy links, solicitation)
  0.85-1.0: definitely spam (clear ads, scams, known patterns)

Rules:
- offensive ≠ spam (trolls annoy, spammers advertise)
- Trust users with message history and reputation
- reason = short explanation for group admins`

  const userPrompt = `MESSAGE: ${messageText}

CONTEXT: ${contextInfo.join(' | ')}`

  const llmResult = await callLLMWithRetry(systemPrompt, userPrompt)
  if (!llmResult) {
    spamLog.warn('LLM failed, using safe fallback')
    return {
      isSpam: false,
      confidence: 0,
      reason: 'LLM unavailable - manual review recommended',
      source: 'llm_fallback'
    }
  }

  const { analysis, model: usedModel } = llmResult

  let spamScore = parseFloat(analysis.spamScore) || 0.5
  spamScore = Math.max(0, Math.min(1, spamScore))
  const isSpam = spamScore >= 0.7

  // Apply boosts
  if (isSpam && userContext.velocityBoost) {
    spamScore = Math.min(0.99, spamScore + userContext.velocityBoost / 100)
    spamLog.debug({ boost: userContext.velocityBoost.toFixed(1), reason: userContext.velocityReason }, 'Velocity boost applied')
  }

  if (isSpam && suspiciousForwardBoost > 0) {
    spamScore = Math.min(0.99, spamScore + suspiciousForwardBoost / 100)
    spamLog.debug({ boost: suspiciousForwardBoost }, 'Suspicious forward boost applied')
  }

  if (isSpam && candidateBoost > 0) {
    spamScore = Math.min(0.99, spamScore + candidateBoost / 100)
    spamLog.debug({ boost: candidateBoost }, 'Candidate signature boost applied')
  }

  spamLog.info({ isSpam, spamScore: spamScore.toFixed(2), source: 'openrouter_llm', model: usedModel }, 'OpenRouter result')

  // Save to Qdrant
  if (embedding) {
    const shouldSave = spamScore >= 0.85 || spamScore <= 0.3

    if (shouldSave) {
      try {
        await saveSpamVector({
          text: messageText,
          embedding,
          classification: isSpam ? 'spam' : 'clean',
          confidence: spamScore,
          features
        })
        qdrantLog.debug({ spamScore: spamScore.toFixed(2) }, 'Saved vector to Qdrant')
      } catch (saveError) {
        qdrantLog.error({ err: saveError.message }, 'Failed to save vector')
      }
    }
  }

  return {
    isSpam,
    confidence: Math.round(spamScore * 100),
    reason: analysis.reason,
    source: 'openrouter_llm'
  }
}

// ========== MAIN FUNCTION ==========

/**
 * Main spam check function using hybrid approach
 */
const checkSpam = async (messageText, ctx, groupSettings) => {
  try {
    initializeCleanup()

    // PHASE 0: Custom rules (fastest)
    const customRuleResult = checkCustomRulesPhase(messageText, groupSettings)
    if (customRuleResult) return customRuleResult

    // PHASE 0.5: SpamSignature check
    const { result: sigResult, candidateBoost } = await checkSpamSignaturesPhase(messageText, ctx)
    if (sigResult) return sigResult

    // PHASE 0.6: ForwardBlacklist check
    const { result: fwdResult, suspiciousBoost } = await checkForwardBlacklistPhase(ctx)
    if (fwdResult) return fwdResult

    // PHASE 1: Quick risk assessment
    const { result: qaResult, quickAssessment } = runQuickAssessmentPhase(ctx)
    if (qaResult) return qaResult

    // Fetch additional context in parallel
    const [userAvatarUrl, userChatInfo, groupDescription] = await Promise.all([
      getUserProfilePhotoUrl(ctx),
      getUserChatInfo(ctx),
      getGroupDescription(ctx)
    ])
    const userBio = userChatInfo.bio
    const userRating = userChatInfo.rating

    // PHASE 2: OpenAI Moderation
    const modResult = await runModerationPhase(ctx, messageText, quickAssessment, userBio, userAvatarUrl)
    if (modResult) return modResult

    // Build user context
    const userContext = buildUserContext(ctx, userRating, quickAssessment)

    // PHASE 3: Velocity check
    const velocityResult = await runVelocityPhase(messageText, ctx, userContext)
    if (velocityResult) return velocityResult

    // PHASE 4: Qdrant vector check
    const { result: qdrantResult, embedding, features } = await runQdrantPhase(messageText, ctx, userContext)
    if (qdrantResult) return qdrantResult

    // PHASE 5: LLM analysis (final fallback)
    return await runLLMPhase(
      messageText,
      ctx,
      userContext,
      groupSettings,
      groupDescription,
      userBio,
      { candidateBoost, suspiciousForwardBoost: suspiciousBoost },
      embedding,
      features
    )
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
  getUserBio,
  humanizeReason
}
