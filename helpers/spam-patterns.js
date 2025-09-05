const crypto = require('crypto')
const connection = require('../database/connection')
const spamPatternSchema = require('../database/models/spamPattern')

// Create model from schema
const SpamPattern = connection.model('SpamPattern', spamPatternSchema)

/**
 * Calculate SHA256 hash of message content
 */
const generateContentHash = (text) => {
  return crypto.createHash('sha256').update(text.toLowerCase().trim()).digest('hex')
}

/**
 * Calculate cosine similarity between two vectors
 */
const cosineSimilarity = (vecA, vecB) => {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i]
    normA += vecA[i] * vecA[i]
    normB += vecB[i] * vecB[i]
  }

  normA = Math.sqrt(normA)
  normB = Math.sqrt(normB)

  if (normA === 0 || normB === 0) return 0
  return dotProduct / (normA * normB)
}

/**
 * Save spam pattern to database using Mongoose
 */
const saveSpamPattern = async ({
  text,
  embedding,
  classification,
  confidence,
  features = {},
  source = 'llm_analysis'
}) => {
  const contentHash = generateContentHash(text)

  try {
    // Check if already exists
    const existing = await SpamPattern.findOne({ contentHash })
    if (existing) {
      // Update hit count and confidence
      await SpamPattern.updateOne(
        { contentHash },
        {
          $inc: { hitCount: 1 },
          $set: {
            lastMatched: new Date(),
            confidence: Math.max(existing.confidence, confidence)
          }
        }
      )
      return existing._id
    }

    // Create new pattern
    const pattern = new SpamPattern({
      contentHash,
      embedding,
      classification,
      confidence,
      features,
      hitCount: 1,
      lastMatched: new Date(),
      source
    })

    const result = await pattern.save()
    return result._id
  } catch (error) {
    console.error('Error saving spam pattern:', error)
    throw error
  }
}

/**
 * Find similar patterns in database
 */
const findSimilarPatterns = async (embedding, threshold = 0.85) => {
  try {
    // OPTIMIZATION: Limit patterns to check (temporary fix until vector DB)
    const maxPatterns = 500 // Limit for performance
    const patterns = await SpamPattern.find({})
      .select('embedding classification confidence features')
      .sort({ lastMatched: -1, hitCount: -1 }) // Prioritize frequently used patterns
      .limit(maxPatterns)
      .lean() // Use lean() for better performance - plain JS objects

    const similarities = []

    for (const pattern of patterns) {
      const similarity = cosineSimilarity(embedding, pattern.embedding)
      if (similarity >= threshold) {
        similarities.push({
          ...pattern,
          similarity
        })
      }
    }

    // Sort by similarity descending and limit results
    similarities.sort((a, b) => b.similarity - a.similarity)

    // Log warning if we're at the limit
    if (patterns.length >= maxPatterns) {
      console.log(`[VECTOR SEARCH] Warning: Reached pattern limit (${maxPatterns}). Consider MongoDB Atlas vector search.`)
    }

    return similarities.slice(0, 20) // Return top 20 matches only
  } catch (error) {
    console.error('Error finding similar patterns:', error)
    return []
  }
}

/**
 * Get classification based on similar patterns
 */
const classifyBySimilarity = async (embedding) => {
  try {
    // Find similar patterns with different thresholds
    const highConfidence = await findSimilarPatterns(embedding, 0.88) // Lowered from 0.90 for better matching
    const mediumConfidence = await findSimilarPatterns(embedding, 0.83) // Lowered from 0.85

    // Check high confidence matches first
    if (highConfidence.length > 0) {
      const bestMatch = highConfidence[0]

      // Update hit count
      await SpamPattern.updateOne(
        { _id: bestMatch._id },
        {
          $inc: { hitCount: 1 },
          $set: { lastMatched: new Date() }
        }
      )

      return {
        classification: bestMatch.classification,
        confidence: Math.max(bestMatch.similarity, bestMatch.confidence * 0.95), // Use max of similarity or slightly reduced confidence
        source: 'local_db',
        matchedPattern: bestMatch._id
      }
    }

    // Check medium confidence - different logic for clean vs spam
    const cleanMatches = mediumConfidence.filter(m => m.classification === 'clean')
    const spamMatches = mediumConfidence.filter(m => m.classification === 'spam')

    // Prefer clean matches with good confidence
    if (cleanMatches.length > 0 && cleanMatches[0].similarity >= 0.85) {
      const bestMatch = cleanMatches[0]

      await SpamPattern.updateOne(
        { _id: bestMatch._id },
        {
          $inc: { hitCount: 1 },
          $set: { lastMatched: new Date() }
        }
      )

      return {
        classification: 'clean',
        confidence: Math.max(bestMatch.similarity * 0.95, bestMatch.confidence * 0.9),
        source: 'local_db',
        matchedPattern: bestMatch._id
      }
    }

    // Check spam matches (be more cautious)
    if (spamMatches.length > 0 && spamMatches[0].confidence > 0.8) {
      const bestMatch = spamMatches[0]

      await SpamPattern.updateOne(
        { _id: bestMatch._id },
        {
          $inc: { hitCount: 1 },
          $set: { lastMatched: new Date() }
        }
      )

      return {
        classification: 'spam',
        confidence: Math.min(bestMatch.confidence, bestMatch.similarity) * 0.95, // Slightly reduce confidence for medium matches
        source: 'local_db',
        matchedPattern: bestMatch._id
      }
    }

    // No confident match found
    return null
  } catch (error) {
    console.error('Error classifying by similarity:', error)
    return null
  }
}

/**
 * Clean up old and unused patterns
 */
const cleanupOldPatterns = async () => {
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

    // Remove rarely used old patterns
    const result = await SpamPattern.deleteMany({
      hitCount: { $lt: 2 },
      createdAt: { $lt: ninetyDaysAgo }
    })

    return result.deletedCount
  } catch (error) {
    console.error('Error cleaning up old patterns:', error)
    return 0
  }
}

/**
 * Merge similar patterns to reduce database size
 */
const mergeSimilarPatterns = async (threshold = 0.95) => {
  try {
    const patterns = await SpamPattern.find({})
      .sort({ hitCount: -1, confidence: -1 })

    const merged = []
    const toDelete = []

    for (let i = 0; i < patterns.length; i++) {
      if (toDelete.includes(patterns[i]._id.toString())) continue

      for (let j = i + 1; j < patterns.length; j++) {
        if (toDelete.includes(patterns[j]._id.toString())) continue

        const similarity = cosineSimilarity(patterns[i].embedding, patterns[j].embedding)

        if (similarity >= threshold && patterns[i].classification === patterns[j].classification) {
          // Keep the one with higher hit count and confidence
          await SpamPattern.updateOne(
            { _id: patterns[i]._id },
            {
              $inc: { hitCount: patterns[j].hitCount },
              $set: {
                confidence: Math.max(patterns[i].confidence, patterns[j].confidence),
                lastMatched: new Date()
              }
            }
          )

          toDelete.push(patterns[j]._id)
          merged.push({ kept: patterns[i]._id, deleted: patterns[j]._id })
        }
      }
    }

    // Delete merged patterns
    if (toDelete.length > 0) {
      await SpamPattern.deleteMany({ _id: { $in: toDelete } })
    }

    return merged.length
  } catch (error) {
    console.error('Error merging similar patterns:', error)
    return 0
  }
}

/**
 * Get database statistics
 */
const getKnowledgeStats = async () => {
  try {
    const stats = await SpamPattern.aggregate([
      {
        $group: {
          _id: '$classification',
          count: { $sum: 1 },
          avgConfidence: { $avg: '$confidence' },
          totalHits: { $sum: '$hitCount' }
        }
      }
    ])

    const totalSize = await SpamPattern.countDocuments()

    // Calculate database size estimate
    const samplePattern = await SpamPattern.findOne()
    const estimatedSizeMB = samplePattern
      ? (totalSize * JSON.stringify(samplePattern).length) / (1024 * 1024)
      : 0

    return {
      totalPatterns: totalSize,
      byClassification: stats,
      estimatedSizeMB: estimatedSizeMB.toFixed(2),
      performanceWarning: totalSize > 500
        ? 'Consider migrating to MongoDB Atlas Vector Search for better performance'
        : null
    }
  } catch (error) {
    console.error('Error getting knowledge stats:', error)
    return {
      totalPatterns: 0,
      byClassification: []
    }
  }
}

module.exports = {
  generateContentHash,
  cosineSimilarity,
  saveSpamPattern,
  findSimilarPatterns,
  classifyBySimilarity,
  cleanupOldPatterns,
  mergeSimilarPatterns,
  getKnowledgeStats
}
