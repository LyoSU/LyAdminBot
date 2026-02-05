const crypto = require('crypto')
const { generateEmbedding, isPlaceholderMediaText } = require('./message-embeddings')
const { saveSpamVector } = require('./spam-vectors')
const { qdrant: sigLog, nlp: nlpLog } = require('./logger')
const nlpClient = require('./nlp-client')

/**
 * Spam Signature System
 *
 * Multi-layer hashing for spam detection:
 * 1. Exact hash - identical text only
 * 2. Normalized hash - ignores numbers, emojis, extra spaces
 * 3. SimHash - fuzzy matching, tolerant to small changes
 * 4. Content hash - structure-based, ignores specific values
 */

// ============================================================================
// TEXT NORMALIZATION
// ============================================================================

/**
 * Light normalization - lowercase, trim, collapse spaces
 */
const normalizeLight = (text) => {
  if (!text) return ''
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Heavy normalization - remove variable content (numbers, emojis, usernames)
 * Keeps the "template" of the message
 */
const normalizeHeavy = (text) => {
  if (!text) return ''
  return text
    .toLowerCase()
    // Remove @mentions
    .replace(/@[\w]+/g, '@_')
    // Remove URLs
    .replace(/https?:\/\/[^\s]+/gi, '_URL_')
    .replace(/t\.me\/[\w+]+/gi, '_URL_')
    // Remove numbers (prices, phone numbers, etc.)
    .replace(/\d+([.,]\d+)?/g, '_NUM_')
    // Remove emojis
    .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
    // Remove currency symbols
    .replace(/[$€£₴₽¥]/g, '_CUR_')
    // Collapse multiple spaces/newlines
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract structural tokens - what the message "looks like"
 * Good for detecting template-based spam
 */
const extractStructure = (text) => {
  if (!text) return ''
  const patterns = []

  // Detect presence of various elements
  if (/@[\w]+/.test(text)) patterns.push('MENTION')
  if (/https?:\/\/|t\.me\//i.test(text)) patterns.push('LINK')
  if (/\d{5,}/.test(text)) patterns.push('LONG_NUM')
  if (/[$€£₴₽¥]\s*\d|^\d+\s*[$€£₴₽¥]/m.test(text)) patterns.push('PRICE')
  if (/[+]?\d[\d\s\-()]{8,}/.test(text)) patterns.push('PHONE')
  if (/[\u{1F300}-\u{1F9FF}]/u.test(text)) patterns.push('EMOJI')
  if (/[!?]{2,}/.test(text)) patterns.push('EXCLAIM')
  if (/[A-Z]{5,}/.test(text)) patterns.push('CAPS')
  if (/крипт|crypto|bitcoin|btc|eth|ton|usdt/i.test(text)) patterns.push('CRYPTO')
  if (/заробі|заработ|earn|profit|income|дохід/i.test(text)) patterns.push('MONEY')
  if (/бот|bot|канал|channel/i.test(text)) patterns.push('PROMO')

  // Add word count bucket
  const words = text.split(/\s+/).length
  if (words < 10) patterns.push('SHORT')
  else if (words < 30) patterns.push('MEDIUM')
  else patterns.push('LONG')

  return patterns.sort().join(':')
}

// ============================================================================
// HASH FUNCTIONS
// ============================================================================

/**
 * Generate MD5 hash (fast, compact)
 */
const md5 = (text) => {
  return crypto.createHash('md5').update(text).digest('hex')
}

/**
 * Generate SHA256 hash (more secure, used for exact matching)
 */
const sha256 = (text) => {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 32)
}

/**
 * SimHash - locality-sensitive hash for fuzzy matching
 * Similar texts produce similar hashes (small Hamming distance)
 */
const simHash = (text, bits = 64) => {
  const tokens = tokenize(text)
  if (tokens.length === 0) return '0'.repeat(16)

  const vector = new Array(bits).fill(0)

  for (const token of tokens) {
    const hash = md5(token)
    for (let i = 0; i < bits; i++) {
      const byteIndex = Math.floor(i / 8)
      const bitIndex = i % 8
      const bit = (parseInt(hash[byteIndex * 2] + hash[byteIndex * 2 + 1], 16) >> bitIndex) & 1
      vector[i] += bit ? 1 : -1
    }
  }

  // Convert to binary string, then to hex
  let result = ''
  for (let i = 0; i < bits; i += 4) {
    let nibble = 0
    for (let j = 0; j < 4 && i + j < bits; j++) {
      if (vector[i + j] > 0) nibble |= (1 << j)
    }
    result += nibble.toString(16)
  }

  return result
}

/**
 * Tokenize text into meaningful chunks
 */
const tokenize = (text) => {
  if (!text) return []

  // Split into words and n-grams
  const words = text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)

  const tokens = [...words]

  // Add bigrams for better context
  for (let i = 0; i < words.length - 1; i++) {
    tokens.push(`${words[i]}_${words[i + 1]}`)
  }

  return tokens
}

/**
 * Calculate Hamming distance between two hex hashes
 * Lower = more similar
 */
const hammingDistance = (hash1, hash2) => {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) return Infinity

  let distance = 0
  for (let i = 0; i < hash1.length; i++) {
    const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16)
    // Count bits in xor result
    distance += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1)
  }
  return distance
}

// ============================================================================
// SIGNATURE GENERATION
// ============================================================================

/**
 * Check if text has meaningful textual content for signature matching.
 * Returns false for emoji-only, sticker placeholders, pure whitespace, etc.
 * Signature matching is only reliable on actual text content.
 */
const hasTextualContent = (text) => {
  if (!text) return false
  // Strip all emoji, variation selectors, zero-width joiners, and whitespace
  const stripped = text
    .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{200D}]|[\u{20E3}]|[\u{1FA00}-\u{1FAFF}]|[\u{2300}-\u{23FF}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]|[\u{E0020}-\u{E007F}]/gu, '')
    .replace(/\s+/g, '')
    .trim()
  // Need at least 5 non-emoji characters to be considered textual
  return stripped.length >= 5
}

const generateSignatures = (text) => {
  if (!text || text.length < 10) return null

  // CRITICAL: Never create signatures for media placeholders
  // This would cause ALL media of that type to be flagged as spam
  if (isPlaceholderMediaText(text)) {
    sigLog.debug({ text }, 'Skipping signature for placeholder media text')
    return null
  }

  // Skip signature matching for non-textual messages (emoji-only, etc.)
  // These messages don't have meaningful content for template matching
  // and cause hash collisions (all emoji normalize to empty string)
  if (!hasTextualContent(text)) {
    sigLog.debug({ textLength: text.length }, 'Skipping signature for non-textual message (emoji-only)')
    return null
  }

  const lightNorm = normalizeLight(text)
  const heavyNorm = normalizeHeavy(text)
  const structure = extractStructure(text)

  // Safety net: if heavy normalization still collapsed text too much,
  // skip normalizedHash/fuzzyHash to prevent collisions
  const hasEnoughNormalized = heavyNorm.length >= 5

  return {
    // Exact match (light normalization only)
    exactHash: sha256(lightNorm),

    // Template match (heavy normalization) - only if text survived normalization
    normalizedHash: hasEnoughNormalized ? sha256(heavyNorm) : null,

    // Fuzzy match (simhash of normalized text) - only if text survived normalization
    fuzzyHash: hasEnoughNormalized ? simHash(heavyNorm) : null,

    // Structure match (what the message "looks like")
    structureHash: md5(structure),

    // Metadata
    structure,
    textLength: text.length,
    wordCount: text.split(/\s+/).length
  }
}

// ============================================================================
// SIGNATURE MATCHING
// ============================================================================

/**
 * Check if a message matches any confirmed spam signatures
 * Returns match info or null
 */
const checkSignatures = async (text, db, options = {}) => {
  const {
    maxHammingDistance = 8, // Max bits different for fuzzy match
    requireConfirmed = true
  } = options

  const signatures = generateSignatures(text)
  if (!signatures) return null

  const statusQuery = requireConfirmed ? { status: 'confirmed' } : {}

  // 1. Check exact hash (fastest, most reliable)
  const exactMatch = await db.SpamSignature.findOne({
    exactHash: signatures.exactHash,
    ...statusQuery
  })

  if (exactMatch) {
    return {
      match: 'exact',
      confidence: 98,
      signature: exactMatch,
      reason: 'Exact spam match (community confirmed)'
    }
  }

  // 2. Check normalized hash (catches variable substitutions)
  // Skip if normalizedHash is null (text collapsed during normalization)
  if (signatures.normalizedHash) {
    const normalizedMatch = await db.SpamSignature.findOne({
      normalizedHash: signatures.normalizedHash,
      ...statusQuery
    })

    if (normalizedMatch) {
      return {
        match: 'normalized',
        confidence: 95,
        signature: normalizedMatch,
        reason: 'Spam template match (numbers/links varied)'
      }
    }
  }

  // 3. Check fuzzy hash with Hamming distance
  // Skip if fuzzyHash is null (text collapsed during normalization)
  if (signatures.fuzzyHash) {
    const fuzzyCandidates = await db.SpamSignature.find({
      fuzzyHash: { $exists: true, $ne: null },
      ...statusQuery
    }).limit(1000).select('fuzzyHash sampleText confirmations')

    for (const candidate of fuzzyCandidates) {
      const distance = hammingDistance(signatures.fuzzyHash, candidate.fuzzyHash)
      if (distance <= maxHammingDistance) {
        // Confidence decreases with distance
        const confidence = Math.max(75, 95 - distance * 2)
        return {
          match: 'fuzzy',
          confidence,
          distance,
          signature: candidate,
          reason: `Similar to known spam (${distance} bits different)`
        }
      }
    }
  }

  // 4. Structure hash - TOO GENERIC for direct action
  // Structure matching causes false positives because it only captures
  // message "shape" (length, punctuation patterns), not semantic content.
  // Two completely different messages can have the same structure.
  //
  // DISABLED: Structure matches should only be used for confidence boosting
  // in spam-check.js candidateSignatureBoost, not for direct spam detection.
  //
  // If re-enabled, use confidence <= 50 (below action threshold)

  return null
}

/**
 * Save confirmed signature to Qdrant for vector similarity matching
 * Runs asynchronously to avoid blocking the main flow
 */
const saveSignatureToQdrant = (signature, db) => {
  setImmediate(async () => {
    try {
      const text = signature.sampleText
      if (!text || text.length < 10) return

      // Generate embedding for the sample text
      const embedding = await generateEmbedding(text, {
        isNewAccount: true, // Treat as high-risk for embedding context
        messageCount: 0,
        hasCaption: false
      })

      if (!embedding) {
        sigLog.warn({ signatureId: signature._id }, 'Failed to generate embedding for signature')
        return
      }

      // Save to Qdrant with high confidence (confirmed signature)
      await saveSpamVector({
        text,
        embedding,
        classification: 'spam',
        confidence: 0.95, // High confidence for confirmed signatures
        features: {
          fromSignature: true,
          signatureStatus: 'confirmed',
          uniqueGroups: signature.uniqueGroups.length
        }
      })

      // Update signature to mark as saved to vector DB
      await db.SpamSignature.updateOne(
        { _id: signature._id },
        { $set: { vectorSaved: true } }
      )

      sigLog.info({
        signatureId: signature._id,
        uniqueGroups: signature.uniqueGroups.length
      }, 'Saved confirmed signature to Qdrant')
    } catch (err) {
      sigLog.warn({ err: err.message, signatureId: signature._id }, 'Failed to save signature to Qdrant')
    }
  })
}

/**
 * Extract NLP metadata for a signature asynchronously
 * Called when signature is first created to populate lang, posSignature, topBigrams
 */
const extractNlpForSignature = (signature, db) => {
  if (!nlpClient.CONFIG.enabled) return

  const text = signature.sampleText
  if (!text || text.length < 10) return

  setImmediate(async () => {
    try {
      const nlpResult = await nlpClient.extract(text)
      if (!nlpResult) {
        nlpLog.debug({ signatureId: signature._id }, 'NLP extraction returned null')
        return
      }

      await db.SpamSignature.updateOne(
        { _id: signature._id },
        {
          $set: {
            nlpMetadata: {
              lang: nlpResult.lang,
              posSignature: nlpResult.pos.slice(0, 10).join('-'),
              topBigrams: nlpResult.bigrams.slice(0, 5)
            }
          }
        }
      )

      nlpLog.info({
        signatureId: signature._id,
        lang: nlpResult.lang,
        bigrams: nlpResult.bigrams.length
      }, 'NLP metadata extracted for signature')
    } catch (err) {
      nlpLog.warn({ err: err.message, signatureId: signature._id }, 'NLP extraction failed')
    }
  })
}

/**
 * Add or update spam signature in database
 *
 * Strategy: Query by exactHash only (matches unique index) for atomic upsert.
 * Then check if normalizedHash match exists and merge if needed.
 */
const addSignature = async (text, db, chatId, options = {}) => {
  const signatures = generateSignatures(text)
  if (!signatures) return null

  // Step 1: Check if normalizedHash already exists (template match)
  // This handles case where same spam template has different exact text
  // Skip if normalizedHash is null (text collapsed during normalization - would match wrong records)
  const existingByNormalized = signatures.normalizedHash
    ? await db.SpamSignature.findOneAndUpdate(
      { normalizedHash: signatures.normalizedHash },
      {
        $inc: { confirmations: 1 },
        $addToSet: { uniqueGroups: chatId },
        $set: {
          lastSeenAt: new Date(),
          fuzzyHash: signatures.fuzzyHash,
          structureHash: signatures.structureHash
        }
      },
      { new: true }
    )
    : null

  if (existingByNormalized) {
    // Found by template - promote if enough groups
    if (existingByNormalized.uniqueGroups.length >= 3 && existingByNormalized.status === 'candidate') {
      // Fix: Use atomic findOneAndUpdate with condition to prevent race condition
      // In multi-worker environments, synchronous flag setting doesn't help
      // because workers read from DB, not shared memory
      const promoted = await db.SpamSignature.findOneAndUpdate(
        {
          _id: existingByNormalized._id,
          status: 'candidate', // Only promote if still candidate
          vectorSaved: { $ne: true } // Only if not already saved to Qdrant
        },
        {
          $set: {
            status: 'confirmed'
            // NOTE: vectorSaved is set by saveSignatureToQdrant AFTER successful save
          }
        },
        { new: true }
      )

      // If we got the document back, we won the race - save to Qdrant
      if (promoted) {
        saveSignatureToQdrant(promoted, db)
        return promoted
      }
      // If null, another worker already promoted it - return fresh data
      return db.SpamSignature.findById(existingByNormalized._id)
    }
    return existingByNormalized
  }

  // Step 2: No template match - upsert by exactHash (unique index ensures no duplicates)
  // Only store normalizedHash/fuzzyHash if they're not null (collapsed text)
  const hashFields = { structureHash: signatures.structureHash }
  if (signatures.normalizedHash) hashFields.normalizedHash = signatures.normalizedHash
  if (signatures.fuzzyHash) hashFields.fuzzyHash = signatures.fuzzyHash

  let result
  try {
    result = await db.SpamSignature.findOneAndUpdate(
      { exactHash: signatures.exactHash },
      {
        $inc: { confirmations: 1 },
        $addToSet: { uniqueGroups: chatId },
        $set: {
          lastSeenAt: new Date(),
          ...hashFields
        },
        $setOnInsert: {
          sampleText: text.substring(0, 200),
          status: 'candidate',
          firstSeenAt: new Date(),
          source: options.source || 'ai_detection'
        }
      },
      { upsert: true, new: true }
    )
  } catch (err) {
    if (err.code === 11000) {
      // Race condition: another request inserted first
      // Try to find by exactHash or normalizedHash (handles template match race)
      const orConditions = [{ exactHash: signatures.exactHash }]
      if (signatures.normalizedHash) orConditions.push({ normalizedHash: signatures.normalizedHash })

      result = await db.SpamSignature.findOneAndUpdate(
        { $or: orConditions },
        {
          $inc: { confirmations: 1 },
          $addToSet: { uniqueGroups: chatId },
          $set: { lastSeenAt: new Date() }
        },
        { new: true }
      )

      // If still null, another concurrent request may have just created it - retry once
      if (!result) {
        result = await db.SpamSignature.findOne({ $or: orConditions })
      }

      // If still nothing, something unexpected happened
      if (!result) {
        throw new Error('Race condition recovery failed: signature not found after duplicate key error')
      }
    } else {
      throw err
    }
  }

  // Extract NLP metadata for new signatures (confirmations === 1 means just created)
  if (result.confirmations === 1 && !result.nlpMetadata?.lang) {
    extractNlpForSignature(result, db)
  }

  // Promote if enough groups - use atomic update for multi-worker safety
  if (result.uniqueGroups.length >= 3 && result.status === 'candidate') {
    const promoted = await db.SpamSignature.findOneAndUpdate(
      {
        _id: result._id,
        status: 'candidate',
        vectorSaved: { $ne: true }
      },
      {
        $set: {
          status: 'confirmed'
          // NOTE: vectorSaved is set by saveSignatureToQdrant AFTER successful save
        }
      },
      { new: true }
    )

    if (promoted) {
      saveSignatureToQdrant(promoted, db)
      return promoted
    }
    // Another worker already promoted - return fresh data
    return db.SpamSignature.findById(result._id)
  }

  return result
}

module.exports = {
  // Normalization
  normalizeLight,
  normalizeHeavy,
  extractStructure,

  // Hashing
  md5,
  sha256,
  simHash,
  hammingDistance,

  // Content detection
  hasTextualContent,

  // High-level API
  generateSignatures,
  checkSignatures,
  addSignature
}
