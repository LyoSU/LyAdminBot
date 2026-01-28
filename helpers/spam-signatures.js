const crypto = require('crypto')
const { generateEmbedding } = require('./message-embeddings')
const { saveSpamVector } = require('./spam-vectors')
const { qdrant: sigLog } = require('./logger')

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
 * Generate all signature hashes for a message
 * Returns object with multiple hash types for storage
 */
const generateSignatures = (text) => {
  if (!text || text.length < 10) return null

  const lightNorm = normalizeLight(text)
  const heavyNorm = normalizeHeavy(text)
  const structure = extractStructure(text)

  return {
    // Exact match (light normalization only)
    exactHash: sha256(lightNorm),

    // Template match (heavy normalization)
    normalizedHash: sha256(heavyNorm),

    // Fuzzy match (simhash of normalized text)
    fuzzyHash: simHash(heavyNorm),

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

  // 3. Check fuzzy hash with Hamming distance
  // This requires fetching candidates and comparing
  const fuzzyCandidates = await db.SpamSignature.find({
    fuzzyHash: { $exists: true },
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

  // 4. Check structure hash (catches reformatted spam)
  const structureMatch = await db.SpamSignature.findOne({
    structureHash: signatures.structureHash,
    confirmations: { $gte: 10 }, // Require more confirmations for structure
    ...statusQuery
  })

  if (structureMatch) {
    return {
      match: 'structure',
      confidence: 70,
      signature: structureMatch,
      reason: 'Matches spam message structure'
    }
  }

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
  const existingByNormalized = await db.SpamSignature.findOneAndUpdate(
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

  if (existingByNormalized) {
    // Found by template - promote if enough groups
    if (existingByNormalized.uniqueGroups.length >= 3 && existingByNormalized.status === 'candidate') {
      existingByNormalized.status = 'confirmed'

      // Fix: Set vectorSaved synchronously BEFORE async operation to prevent race condition
      // Two concurrent requests could both see vectorSaved=false and trigger duplicate saves
      const shouldSaveToQdrant = !existingByNormalized.vectorSaved
      if (shouldSaveToQdrant) {
        existingByNormalized.vectorSaved = true // Mark sync to prevent race
      }

      await existingByNormalized.save()

      // Now trigger async save - flag already persisted
      if (shouldSaveToQdrant) {
        saveSignatureToQdrant(existingByNormalized, db)
      }
    }
    return existingByNormalized
  }

  // Step 2: No template match - upsert by exactHash (unique index ensures no duplicates)
  let result
  try {
    result = await db.SpamSignature.findOneAndUpdate(
      { exactHash: signatures.exactHash },
      {
        $inc: { confirmations: 1 },
        $addToSet: { uniqueGroups: chatId },
        $set: {
          lastSeenAt: new Date(),
          normalizedHash: signatures.normalizedHash,
          fuzzyHash: signatures.fuzzyHash,
          structureHash: signatures.structureHash
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
      // Try to find by normalizedHash first (handles template match race)
      result = await db.SpamSignature.findOneAndUpdate(
        { $or: [{ exactHash: signatures.exactHash }, { normalizedHash: signatures.normalizedHash }] },
        {
          $inc: { confirmations: 1 },
          $addToSet: { uniqueGroups: chatId },
          $set: { lastSeenAt: new Date() }
        },
        { new: true }
      )

      // If still null, another concurrent request may have just created it - retry once
      if (!result) {
        result = await db.SpamSignature.findOne({
          $or: [{ exactHash: signatures.exactHash }, { normalizedHash: signatures.normalizedHash }]
        })
      }

      // If still nothing, something unexpected happened
      if (!result) {
        throw new Error('Race condition recovery failed: signature not found after duplicate key error')
      }
    } else {
      throw err
    }
  }

  // Promote if enough groups
  if (result.uniqueGroups.length >= 3 && result.status === 'candidate') {
    result.status = 'confirmed'

    // Fix: Set vectorSaved synchronously BEFORE async operation to prevent race condition
    const shouldSaveToQdrant = !result.vectorSaved
    if (shouldSaveToQdrant) {
      result.vectorSaved = true // Mark sync to prevent race
    }

    await result.save()

    // Now trigger async save - flag already persisted
    if (shouldSaveToQdrant) {
      saveSignatureToQdrant(result, db)
    }
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

  // High-level API
  generateSignatures,
  checkSignatures,
  addSignature
}
