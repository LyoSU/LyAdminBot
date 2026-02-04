const { OpenAI } = require('openai')
const { moderation: embedLog } = require('./logger')

// Create OpenAI client for embeddings
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

/**
 * Normalize Telegram message for embedding
 */
const normalizeMessage = (text) => {
  if (!text) return ''

  let normalized = text

  // Remove Telegram-specific elements
  normalized = normalized.replace(/@\w+/g, '') // Remove @mentions
  normalized = normalized.replace(/https?:\/\/[^\s]+/gi, ' URL ') // Replace URLs
  normalized = normalized.replace(/t\.me\/[^\s]+/gi, ' TELEGRAM_LINK ') // Telegram links

  // Remove excessive emoji spam
  normalized = normalized.replace(/(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff]){3,}/g, ' EMOJI_SPAM ')

  // Remove invisible characters
  normalized = normalized.replace(/[\u200B\u200C\u200D\uFEFF]/g, '')

  // Normalize whitespace
  normalized = normalized.replace(/\s+/g, ' ')

  // Trim and lowercase
  normalized = normalized.trim().toLowerCase()

  return normalized
}

/**
 * Extract message features for analysis
 */
const extractFeatures = (text, userContext = {}) => {
  const features = {
    messageLength: text.length,
    wordCount: text.split(/\s+/).filter(w => w.length > 0).length,
    hasLinks: /https?:\/\/|t\.me\//i.test(text),
    hasEmojis: /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/u.test(text),
    hasMentions: /@\w+/.test(text),
    hasPhoneNumbers: /\+?\d{10,}/g.test(text),
    hasEmails: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g.test(text),
    capitalRatio: text.length > 0 ? (text.match(/[A-Z]/g) || []).length / text.length : 0,
    digitRatio: text.length > 0 ? (text.match(/\d/g) || []).length / text.length : 0,
    specialCharRatio: text.length > 0 ? (text.match(/[^a-zA-Z0-9\s]/g) || []).length / text.length : 0
  }

  // Add user context features
  if (userContext.isNewUser !== undefined) {
    features.isNewUser = userContext.isNewUser
  }
  if (userContext.isPremium !== undefined) {
    features.isPremium = userContext.isPremium
  }
  if (userContext.messageCount !== undefined) {
    features.userMessageCount = userContext.messageCount
  }

  return features
}

/**
 * Generate embedding for message with context
 */
const generateEmbedding = async (text, userContext = {}) => {
  try {
    let processedText = normalizeMessage(text)

    // Skip embedding for placeholder media text without captions
    if (isPlaceholderMediaText(text) && !userContext.hasCaption) {
      return null
    }

    // Skip if message is too short or empty after normalization
    if (processedText.length < 3) {
      return null
    }

    // Add minimal context for better embeddings (only for edge cases)
    if (userContext.isNewAccount && userContext.messageCount <= 1) {
      processedText = `first message: ${processedText}`
    }

    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: processedText,
      encoding_format: 'float'
    })

    return response.data[0].embedding
  } catch (error) {
    embedLog.error({ err: error.message }, 'Error generating embedding')
    return null
  }
}

/**
 * Check if text is just a placeholder for media without meaningful content
 * These should never be used for spam signatures or embeddings
 * 
 * Format: [MediaType: file_unique_id] or [Media message] for unknown types
 */
const isPlaceholderMediaText = (text) => {
  if (!text) return false
  const normalized = text.toLowerCase().trim()
  
  // Catch-all placeholder for unknown media types
  if (normalized === '[media message]') return true
  
  // All media placeholders follow pattern: [Type: file_unique_id]
  const mediaTypes = [
    'sticker', 'animation', 'video', 'videonote', 'voice', 
    'audio', 'photo', 'document'
  ]
  
  for (const type of mediaTypes) {
    if (normalized.startsWith(`[${type}:`)) return true
  }
  
  // Legacy patterns (for backwards compatibility)
  const legacyPlaceholders = [
    '[photo]', '[voice message]', '[video]', '[audio]'
  ]
  if (legacyPlaceholders.includes(normalized)) return true
  
  return false
}

/**
 * Batch generate embeddings for multiple messages
 */
const generateBatchEmbeddings = async (texts) => {
  try {
    const normalized = texts.map(text => normalizeMessage(text))
    const validTexts = normalized.filter(text => text.length >= 3)

    if (validTexts.length === 0) {
      return []
    }

    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: validTexts,
      encoding_format: 'float'
    })

    return response.data.map(item => item.embedding)
  } catch (error) {
    embedLog.error({ err: error.message }, 'Error generating batch embeddings')
    return []
  }
}

/**
 * Calculate adaptive similarity threshold based on features
 */
const getAdaptiveThreshold = (features, baseThreshold = 0.85) => {
  let threshold = baseThreshold

  // Adjust threshold based on suspicious features
  if (features.hasLinks) {
    threshold -= 0.05 // Lower threshold for messages with links
  }
  if (features.isNewUser) {
    threshold -= 0.05 // Lower threshold for new users
  }
  if (features.hasPhoneNumbers || features.hasEmails) {
    threshold -= 0.03 // Slightly lower for contact info
  }
  if (features.capitalRatio > 0.3) {
    threshold -= 0.02 // Lower for excessive capitals
  }

  // Increase threshold for trusted indicators
  if (features.isPremium) {
    threshold += 0.05
  }
  if (features.userMessageCount > 100) {
    threshold += 0.03
  }

  // Keep threshold in reasonable bounds
  return Math.max(0.65, Math.min(0.95, threshold))
}

module.exports = {
  normalizeMessage,
  extractFeatures,
  generateEmbedding,
  generateBatchEmbeddings,
  getAdaptiveThreshold,
  isPlaceholderMediaText
}
